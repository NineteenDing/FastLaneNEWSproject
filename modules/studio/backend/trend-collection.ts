import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { Conflict, audit } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "./collection-admission.ts";
import { platformSessionSecret, platformSessionUnchanged } from "./platform-sessions.ts";
import { trendCatalog } from "./trend-sources.ts";
import { readTrendBoard, TrendReadFailure } from "./trend-reader.ts";
import type { TrendPlatform, TrendSignal } from "../contracts.ts";
import { trendDeepReadState } from "./trend-deep-read.ts";

import { collectionEnabled } from "@aihot/backend/operations/collection-control";
export const trendsCollecting = collectionEnabled;
export const trendQueue = defineQueue<{ sourceId: string }>({
  name: "studio.trends.collect", options: { policy: "short", retryLimit: 0, expireInSeconds: 180 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission({ enabled: trendsCollecting }),
  async run(jobs) { for (const job of jobs) {
    if (!trendsCollecting()) throw new QueueDeferred("采集已暂停");
    await collect(job.sourceId);
  } },
});

export async function enqueueTrend(platform: string, actor: string) {
  const board = trendCatalog.find(board => board.platform === platform);
  if (!board) throw new Conflict("这个热榜尚未支持");
  const [source] = await sql<{ source_id: string; enabled: boolean; archived: boolean }[]>`SELECT b.source_id, s.enabled, s.archived
    FROM studio_trend_boards b JOIN sources s ON s.id = b.source_id WHERE b.platform = ${platform}`;
  if (!source) return null;
  if (!trendsCollecting()) throw new Conflict("采集开关尚未启用");
  if (!source.enabled || source.archived) throw new Conflict("请先恢复并启用这个热榜来源");
  const jobId = await enqueueOn(trendQueue, { sourceId: source.source_id }, { singletonKey: source.source_id, group: { id: "platform-trends" } });
  if (jobId) await audit(actor, "studio.trend.check", `source:${source.source_id}`, null, null, { queued: true });
  return { queued: !!jobId };
}

export async function scheduleTrends(now = new Date()) {
  if (!trendsCollecting()) return { queued: 0 };
  const boards = await sql<{ platform: string }[]>`SELECT b.platform FROM studio_trend_boards b JOIN sources s ON s.id = b.source_id
    LEFT JOIN studio_trend_collection c ON c.platform = b.platform WHERE s.enabled AND NOT s.archived
      AND (c.platform IS NULL OR c.next_check_at <= ${now})
      AND (c.state IS DISTINCT FROM 'running' OR c.started_at < ${now} - interval '2 minutes')
    ORDER BY c.next_check_at NULLS FIRST, b.platform LIMIT 20`;
  let queued = 0;
  for (const board of boards) if ((await enqueueTrend(board.platform, "system"))?.queued) queued++;
  return { queued };
}

async function collect(sourceId: string) {
  const token = randomUUID();
  const claim = await sql.begin(async db => {
    const [source] = await db<{ platform: TrendPlatform; version: Date }[]>`SELECT b.platform, s.updated_at AS version
      FROM studio_trend_boards b JOIN sources s ON s.id = b.source_id WHERE b.source_id = ${sourceId} AND s.enabled AND NOT s.archived FOR UPDATE OF s`;
    if (!source) return null;
    const [lease] = await db`INSERT INTO studio_trend_collection (platform, state, run_token) VALUES (${source.platform}, 'running', ${token})
      ON CONFLICT (platform) DO UPDATE SET state = 'running', run_token = EXCLUDED.run_token, started_at = now(), error_code = NULL
      WHERE studio_trend_collection.state <> 'running' OR studio_trend_collection.started_at < now() - interval '2 minutes' RETURNING platform`;
    return lease ? source : null;
  });
  if (!claim) return;
  const session = claim.platform === "baidu" ? { cookie: "", version: 0, readable: true } : await platformSessionSecret(claim.platform);
  async function interrupted(db: Tx) {
    const [source] = await db<{ enabled: boolean; archived: boolean; version: Date }[]>`SELECT enabled, archived, updated_at AS version FROM sources WHERE id = ${sourceId} FOR UPDATE`;
    const [lease] = await db`SELECT platform FROM studio_trend_collection WHERE platform = ${claim!.platform} AND run_token = ${token} FOR UPDATE`;
    if (!lease) return true;
    if (!trendsCollecting() || !source?.enabled || source.archived || source.version.getTime() !== claim!.version.getTime()
      || claim!.platform !== "baidu" && !await platformSessionUnchanged(db, claim!.platform, session.version)) {
      await db`UPDATE studio_trend_collection SET state = 'interrupted', completed_at = now(), next_check_at = now(), error_code = NULL WHERE platform = ${claim!.platform} AND run_token = ${token}`;
      return true;
    }
    return false;
  }
  try {
    if (!session.readable) throw new Error("平台会话不可读取");
    const items = (await readTrendBoard(claim.platform, session.cookie)).slice(0, 20);
    if (new Set(items.map(item => item.externalId)).size !== items.length) throw new Error("同次榜单包含重复条目，未保存有歧义的排名");
    await sql.begin(async db => {
      if (await interrupted(db)) return;
      for (const item of items) {
        const [signal] = await db<{ id: string }[]>`INSERT INTO studio_trend_signals (id, platform, external_id, title, url)
          VALUES (${randomUUID()}, ${claim.platform}, ${item.externalId}, ${item.title}, ${item.url})
          ON CONFLICT (platform, external_id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, last_seen_at = now(),
            disposition = CASE WHEN studio_trend_signals.title = EXCLUDED.title AND studio_trend_signals.url = EXCLUDED.url THEN studio_trend_signals.disposition ELSE 'pending_relevance' END,
            relevance_key = CASE WHEN studio_trend_signals.title = EXCLUDED.title AND studio_trend_signals.url = EXCLUDED.url THEN studio_trend_signals.relevance_key ELSE NULL END RETURNING id`;
        await db`INSERT INTO studio_trend_observations (signal_id, rank, raw_heat, metrics)
          VALUES (${signal!.id}, ${item.rank}, ${item.rawHeat}, ${db.json(item.metrics)})`;
      }
      await db`UPDATE studio_trend_collection SET state = 'ready', checked_at = now(), completed_at = now(), item_count = ${items.length}, fail_count = 0,
        error_code = NULL, next_check_at = now() + interval '30 minutes' WHERE platform = ${claim.platform} AND run_token = ${token}`;
      await db`UPDATE sources SET last_ok_at = now(), last_fetch_at = now(), fail_count = 0, health = 'ok', last_error = NULL, updated_at = now() WHERE id = ${sourceId}`;
    });
  } catch (error) {
    console.error("[trend]", claim.platform, error instanceof Error ? error.message : String(error));
    const code = error instanceof TrendReadFailure ? error.code : session.readable ? "platform_failed" : "login_required";
    const stopped = await sql.begin(async db => {
      if (await interrupted(db)) return true;
      await db`UPDATE studio_trend_collection SET state = 'failed', completed_at = now(), fail_count = fail_count + 1, error_code = ${code},
        next_check_at = now() + make_interval(mins => LEAST(30 * (fail_count + 2), 360)) WHERE platform = ${claim.platform} AND run_token = ${token}`;
      await db`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        last_error = ${code}, updated_at = now() WHERE id = ${sourceId}`;
      return false;
    });
    if (stopped) return;
    throw new Error("平台热榜检查未完成，已保留之前成功结果；请检查平台登录、限流和网络");
  }
}

export async function trendSignals(input: unknown) {
  const query = z.object({ platform: z.enum(["douyin", "bilibili", "weibo", "zhihu", "tieba", "kuaishou", "xhs", "baidu"]).optional(),
    current: z.literal("true").optional(),
    q: z.string().trim().max(200).default(""), page: z.coerce.number().int().positive().max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(input);
  const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  return sql.begin("isolation level repeatable read read only", async db => {
    const where = db`(${query.platform ?? null}::text IS NULL OR platform = ${query.platform ?? null}) AND title ILIKE ${pattern}
      AND (${query.current === "true"} = FALSE OR last_seen_at >= coalesce((SELECT checked_at FROM studio_trend_collection c
        WHERE c.platform = studio_trend_signals.platform), 'epoch'::timestamptz))
      AND (${query.current === "true"} = FALSE OR (SELECT rank FROM studio_trend_observations WHERE signal_id = studio_trend_signals.id ORDER BY observed_at DESC, id DESC LIMIT 1) <= 20)`;
    const ordering = query.current === "true" ? db`(SELECT rank FROM studio_trend_observations WHERE signal_id = studio_trend_signals.id ORDER BY observed_at DESC, id DESC LIMIT 1) ASC NULLS LAST`
      : db`last_seen_at DESC`;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_trend_signals WHERE ${where}`;
    type SignalRow = Omit<TrendSignal, "observations" | "relevance" | "firstSeenAt" | "lastSeenAt"> & { firstSeenAt: Date; lastSeenAt: Date; contextKey: string | null };
    const signals = await db<SignalRow[]>`SELECT id, platform, title, url, disposition,
      first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", relevance_key AS "contextKey" FROM studio_trend_signals WHERE ${where} ORDER BY ${ordering}, id LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    const [queueSchema] = await db`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`;
    const jobJoin = queueSchema!.present ? db`LEFT JOIN pgboss.job j ON j.name = 'studio.trends.relevance' AND j.id = r.job_id`
      : db`LEFT JOIN (SELECT NULL::uuid AS id, NULL::text AS state) j ON true`;
    const rows = [];
    for (const signal of signals) {
      const observations = await db<{ observedAt: Date; rank: number; rawHeat: string | null; metrics: TrendSignal["observations"][number]["metrics"] }[]>`
        SELECT observed_at AS "observedAt", rank, raw_heat AS "rawHeat", metrics FROM (SELECT * FROM studio_trend_observations
          WHERE signal_id = ${signal.id} ORDER BY observed_at DESC, id DESC LIMIT 100) recent ORDER BY observed_at, id`;
      const interrupted = db`r.state = 'queued' AND (j.id IS NULL OR j.state IN ('failed', 'cancelled', 'completed'))`;
      const [relevance] = await db<NonNullable<TrendSignal["relevance"]>[]>`SELECT CASE WHEN ${interrupted} THEN 'failed'
        WHEN r.state = 'queued' AND j.state = 'active' THEN 'running' ELSE r.state END AS state,
        r.result, r.receipt_id AS "receiptId", CASE WHEN ${interrupted} THEN '任务已终止且尚未保存判断结果，可显式重试' ELSE r.error END AS error,
        r.input->>'policy' AS policy, r.input->>'modelIdentity' AS "modelIdentity" FROM studio_trend_relevance r
        JOIN studio_trend_signals s ON s.id = r.signal_id AND s.relevance_key = r.context_key ${jobJoin} WHERE s.id = ${signal.id}`;
      const { contextKey, ...visible } = signal;
      rows.push({ ...visible, deepRead: await trendDeepReadState(db, signal.id, contextKey), relevance: relevance ?? null, firstSeenAt: signal.firstSeenAt.toISOString(), lastSeenAt: signal.lastSeenAt.toISOString(),
        observations: observations.map(observation => ({ ...observation, observedAt: observation.observedAt.toISOString() })) });
    }
    return { rows, total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
