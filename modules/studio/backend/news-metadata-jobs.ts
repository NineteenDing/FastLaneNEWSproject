import { sql } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue, QueueDeferred } from "@aihot/backend/jobs/queue";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { createCollectionAdmission } from "./collection-admission.ts";
import { matchesSourceMetadata } from "./metadata-sql.ts";
import { refreshNewsMetadata } from "./news-metadata.ts";

type Job = { sourceId: string; version: string; profileVersion: number };

/** One bounded, durable task; parser, images and manual-field rules stay shared. */
export function createNewsMetadataQueue(resources: Pick<NonNullable<Parameters<typeof createCollectionAdmission>[0]>, "host" | "disk" | "database"> = {}) {
  return defineQueue<Job>({
    name: "studio.news.metadata", executionGroup: "studio-creator-media",
    options: { policy: "short", retryLimit: 0, expireInSeconds: 120 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
    admission: createCollectionAdmission({ ...resources, heavy: true }),
    async run(jobs) {
      for (const job of jobs) {
        if (!collectionEnabled()) throw new QueueDeferred("采集已暂停");
        const [source] = await sql`SELECT enabled, archived FROM sources WHERE id = ${job.sourceId}`;
        if (!source?.enabled || source.archived) continue;
        try { await refreshNewsMetadata(job.sourceId, { version: job.version, profileVersion: job.profileVersion }, "system:news-metadata", "background"); }
        catch (error) { if (!(error instanceof Conflict)) throw error; }
      }
    },
  });
}
export const newsMetadataQueue = createNewsMetadataQueue();

/** No outbound requests here or on card reads. Saved metadata is the retry checkpoint. */
export async function scheduleNewsMetadata() {
  if (!collectionEnabled()) return { queued: 0 };
  await ensureQueue(newsMetadataQueue.name, newsMetadataQueue.options);
  const now = new Date();
  return sql.begin(async db => {
    const due = await db<{ id: string; updated_at: Date; profile_version: number }[]>`
      SELECT s.id, s.updated_at, COALESCE(profile.version, 0) AS profile_version
      FROM sources s LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
      LEFT JOIN studio_source_metadata metadata ON metadata.source_id = s.id AND ${matchesSourceMetadata(db)}
      WHERE s.enabled AND NOT s.archived AND (
        metadata.source_id IS NULL
        OR metadata.state <> 'needs_homepage' AND metadata.checked_at <= ${now}::timestamptz
          - CASE WHEN metadata.state = 'failed' OR metadata.icon_state = 'failed' THEN interval '1 day' ELSE interval '7 days' END)
      AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${newsMetadataQueue.name}
        AND j.singleton_key = s.id AND j.state IN ('created', 'retry', 'active'))
      ORDER BY metadata.checked_at NULLS FIRST, s.id FOR UPDATE OF s SKIP LOCKED LIMIT 20`;
    let queued = 0;
    for (const source of due) if (await enqueueOn(newsMetadataQueue, { sourceId: source.id, version: source.updated_at.toISOString(), profileVersion: source.profile_version },
      { singletonKey: source.id, group: { id: "news-metadata" } }, db)) queued++;
    return { queued };
  });
}
