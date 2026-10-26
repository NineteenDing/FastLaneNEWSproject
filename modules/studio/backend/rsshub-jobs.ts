import { sql } from "@aihot/backend/db";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import { LEGACY_RSSHUB_ROUTES } from "./rsshub-routes.ts";
import { newsBridgeSettings } from "./news-bridge.ts";
import { rsshubState } from "./rsshub-client.ts";
import { createHostResourceMonitor } from "./host-resources.ts";
import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createDatabaseResourceMonitor } from "./database-resources.ts";
import { createCollectionAdmission } from "./collection-admission.ts";
import { trendSourcePlatform } from "./trend-sources.ts";

import { collectionEnabled } from "@aihot/backend/operations/collection-control";
export const bridgeCollecting = () => collectionEnabled() && rsshubState() === "configured";

/** The supplied monitor is a real Module; tests replace only its OS counters/clock seams. */
export function createBridgeQueue(hostResources = createHostResourceMonitor(), diskResources = createDiskResourceMonitor(),
  databaseResources = createDatabaseResourceMonitor()) {
  return defineQueue<{ sourceId: string }>({
    name: "studio.rsshub.collect",
    options: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
    admission: createCollectionAdmission({ host: hostResources, disk: diskResources, database: databaseResources, enabled: bridgeCollecting }),
    async run(jobs) {
      const results = [];
      for (const job of jobs) {
        if (!bridgeCollecting()) throw new QueueDeferred("采集已暂停或RSSHub未就绪");
        if (!await trendSourcePlatform(job.sourceId)) results.push(await collectSource(job.sourceId));
      }
      return results;
    },
  });
}

export const bridgeQueue = createBridgeQueue();

export async function enqueueNewsBridge(source: { id: string }) {
  const settings = await newsBridgeSettings(source.id);
  if (!bridgeCollecting() || !settings?.route) throw new UnsupportedConfig("请启用采集并配置RSSHub运行服务及来源路由");
  const jobId = await enqueueOn(bridgeQueue, { sourceId: source.id }, { singletonKey: source.id, group: { id: "rsshub-host" } });
  return { queued: !!jobId };
}

/** Reuse source due times and persistent jobs; generic external push sources are not polled. */
export async function scheduleNewsBridges() {
  if (!bridgeCollecting()) return { queued: 0 };
  const due = await sql<{ id: string }[]>`SELECT s.id FROM sources s
    LEFT JOIN studio_rsshub_bridges bridge ON bridge.source_id = s.id
    WHERE s.kind = 'external' AND s.enabled AND NOT s.archived AND (s.next_fetch_at IS NULL OR s.next_fetch_at <= now())
      AND NOT EXISTS (SELECT 1 FROM studio_trend_boards trend WHERE trend.source_id = s.id)
      AND (bridge.source_id IS NOT NULL OR s.id = ANY(${Object.keys(LEGACY_RSSHUB_ROUTES)}::text[]))
    ORDER BY s.next_fetch_at NULLS FIRST, s.id LIMIT 100`;
  let queued = 0;
  for (const source of due) if ((await enqueueNewsBridge(source)).queued) queued++;
  return { queued };
}
