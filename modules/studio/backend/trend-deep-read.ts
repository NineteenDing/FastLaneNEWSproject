import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { contentLink, submitContentImport, contentImportQueue } from "./content-imports.ts";
import { ensureQueue } from "@aihot/backend/jobs/queue";
import { creatorsCollecting } from "./creator-collection.ts";

const defaults = { version: 0, enabled: true, dailyLimit: 24 };
const dayOf = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
class QuotaReached extends Error {}
async function settings(db: typeof sql | Tx) {
  const [saved] = await db<{ value: typeof defaults }[]>`SELECT value FROM settings WHERE key = 'studio.trends.deep-read'`;
  return saved?.value ?? defaults;
}
export async function trendDeepReadSettings(db: typeof sql | Tx = sql) {
  const value = await settings(db), day = dayOf();
  const [count] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_trend_deep_reads WHERE budget_day = ${day} AND charged`;
  return { ...value, day, timeZone: "Asia/Hong_Kong", usedToday: count!.count, remainingToday: Math.max(0, value.dailyLimit - count!.count),
    unit: "new_signal_contexts", collectionEnabled: creatorsCollecting() };
}
export async function saveTrendDeepReadSettings(input: unknown, actor: string) {
  const value = z.object({ version: z.number().int().nonnegative(), enabled: z.boolean(), dailyLimit: z.number().int().min(0).max(100) }).strict().parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtext('studio.trends.deep-read'))`;
    const before = await settings(db); if (value.version !== before.version) throw new Conflict("热榜深读设置已改变，请刷新重试");
    const next = { ...value, version: value.version + 1 };
    await db`INSERT INTO settings (key, value, updated_by) VALUES ('studio.trends.deep-read', ${db.json(next)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "studio.trends.deep-read.settings", "settings:studio.trends.deep-read", null, before, next, { db });
    return trendDeepReadSettings(db);
  });
}

/** One independent daily allowance, linked to existing content imports. A hot title never becomes body text. */
export async function submitTrendDeepRead(input: unknown, actor: string) {
  const query = z.object({ retryFailed: z.boolean().default(false) }).strict().parse(input);
  if (!creatorsCollecting()) throw new Conflict("采集开关尚未启用");
  await ensureQueue(contentImportQueue.name, contentImportQueue.options);
  const candidates = await sql<{ id: string; platform: string; title: string; url: string; key: string }[]>`SELECT s.id, s.platform, s.title, s.url, s.relevance_key AS key
    FROM studio_trend_signals s JOIN studio_trend_relevance r ON r.signal_id = s.id AND r.context_key = s.relevance_key
    JOIN studio_trend_boards b ON b.platform = s.platform JOIN sources source ON source.id = b.source_id
    LEFT JOIN studio_trend_deep_reads d ON d.signal_id = s.id AND d.relevance_key = s.relevance_key
    LEFT JOIN studio_content_imports i ON i.id = d.import_id
    WHERE source.enabled AND NOT source.archived AND r.state = 'completed' AND r.result->>'decision' = 'relevant'
      AND s.last_seen_at >= now() - interval '2 hours'
      AND NOT EXISTS (SELECT 1 FROM studio_trend_event_links l WHERE l.signal_id=s.id AND l.signal_context_key=s.relevance_key)
      AND (d.signal_id IS NULL OR i.state = 'interrupted' OR (${query.retryFailed} AND i.state <> 'ready'
        AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${contentImportQueue.name} AND j.id = i.job_id AND j.state IN ('created', 'retry', 'active'))))
    ORDER BY s.last_seen_at DESC, s.id LIMIT 50`;
  let queuedCount = 0, linkedCount = 0, limitedCount = 0, awaitingRepresentativeCount = 0;
  for (const candidate of candidates) {
    let representative: { platform: "weibo" | "douyin" | "kuaishou" | "zhihu" | "tieba"; keyword: string } | undefined;
    try { contentLink(candidate.url); } catch {
      if (candidate.platform === "weibo" || candidate.platform === "douyin" || candidate.platform === "kuaishou" || candidate.platform === "zhihu" || candidate.platform === "tieba") representative = { platform: candidate.platform, keyword: candidate.title };
      else { awaitingRepresentativeCount++; continue; }
    }
    try {
      const result = await sql.begin(async db => {
        await db`SELECT pg_advisory_xact_lock(hashtext('studio.trends.deep-read'))`;
        const value = await settings(db); if (!value.enabled) return null;
        const [current] = await db`SELECT id FROM studio_trend_signals WHERE id = ${candidate.id} AND relevance_key = ${candidate.key}`;
        if (!current) return null;
        const [existing] = await db`SELECT d.charged, i.state FROM studio_trend_deep_reads d JOIN studio_content_imports i ON i.id = d.import_id
          WHERE d.signal_id = ${candidate.id} AND d.relevance_key = ${candidate.key}`;
        const imported = await submitContentImport({ url: candidate.url, retryFailed: query.retryFailed || existing?.state === 'interrupted' }, actor,
          { db, priority: -10, trend: { signalId: candidate.id, key: candidate.key }, representative });
        const day = dayOf();
        const [used] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_trend_deep_reads WHERE budget_day = ${day} AND charged`;
        if (imported.queued && !existing?.charged && used!.count >= value.dailyLimit) throw new QuotaReached();
        const observations = await db`SELECT rank, raw_heat AS "rawHeat", metrics, observed_at AS "observedAt" FROM (SELECT * FROM studio_trend_observations
          WHERE signal_id = ${candidate.id} ORDER BY observed_at DESC, id DESC LIMIT 100) o ORDER BY observed_at, id`;
        const snapshot = { id: candidate.id, platform: candidate.platform, title: candidate.title, url: candidate.url, method: representative ? "search_representative" : "direct_content", observations };
        await db`INSERT INTO studio_trend_deep_reads (signal_id, relevance_key, import_id, signal_snapshot, budget_day, charged)
          VALUES (${candidate.id}, ${candidate.key}, ${imported.item!.id}, ${db.json(snapshot)}, ${day}, ${imported.queued})
          ON CONFLICT (signal_id, relevance_key) DO UPDATE SET import_id = EXCLUDED.import_id,
            budget_day = CASE WHEN NOT studio_trend_deep_reads.charged AND EXCLUDED.charged THEN EXCLUDED.budget_day ELSE studio_trend_deep_reads.budget_day END,
            charged = studio_trend_deep_reads.charged OR EXCLUDED.charged`;
        return imported;
      });
      if (result) { linkedCount++; if (result.queued) queuedCount++; }
    } catch (error) { if (error instanceof QuotaReached) limitedCount++; else throw error; }
  }
  return { queuedCount, linkedCount, limitedCount, awaitingRepresentativeCount };
}
export async function scheduleTrendDeepRead() {
  return creatorsCollecting() && (await settings(sql)).enabled ? submitTrendDeepRead({}, "system:studio.trends.deep-read") : { queuedCount: 0 };
}

export async function trendDeepReadState(db: Tx, signalId: string, key: string | null) {
  const [row] = await db`SELECT i.state, i.post_id, i.job_id, i.error_code, d.charged, d.budget_day, p.content->>'kind' AS kind, t.post_id AS transcript
    FROM studio_trend_deep_reads d JOIN studio_content_imports i ON i.id = d.import_id LEFT JOIN studio_creator_posts p ON p.id = i.post_id
    LEFT JOIN studio_media_transcripts t ON t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint WHERE d.signal_id = ${signalId} AND d.relevance_key = ${key}`;
  if (row && ["queued", "running"].includes(row.state)) {
    const [job] = await db`SELECT state FROM pgboss.job WHERE name = ${contentImportQueue.name} AND id = ${row.job_id}`;
    if (!job || ["completed", "failed", "cancelled"].includes(job.state)) { row.state = "failed"; row.error_code = "job_interrupted"; }
    else row.state = job.state === "active" ? "running" : "queued";
  }
  return row ? { state: row.state === 'ready' ? row.kind === 'video' && !row.transcript ? "awaiting_transcript" : "ready" : row.state,
    materialId: row.post_id ? "creator:" + row.post_id : null, errorCode: row.error_code, charged: row.charged, budgetDay: row.budget_day } : null;
}
