import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { topicAudience } from "./topic-columns.ts";
import { classifyTrendTitle } from "./rsshub-keywords.ts";
import type { TrendPlatform } from "../contracts.ts";

const policy = "studio-trend-keywords-v2";
type Input = { signal: { id: string; platform: TrendPlatform; title: string; url: string }; audience: string; policy: string; modelIdentity: string };
type Job = { signalId: string; key: string; runToken: string };
const resultSchema = z.object({ decision: z.enum(["relevant", "excluded", "uncertain"]), reason: z.string().trim().min(1).max(1000),
  titleQuote: z.string().trim().min(1).max(500), viewerProblem: z.string().trim().min(1).max(500).nullable(),
}).strict();
const disposition = (decision: string) => decision === "relevant" ? "awaiting_deep_read" : decision === "excluded" ? "excluded" : "needs_verification";

export const trendRelevanceQueue = defineQueue<Job>({
  name: "studio.trends.relevance", options: { policy: "short", retryLimit: 0, expireInSeconds: 180 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  async run(jobs) { for (const job of jobs) await analyze(job); },
});

/** Bounded local keyword screening. Ranking changes reuse the same title context without model calls. */
export async function submitTrendRelevance(input: unknown, actor: string) {
  const query = z.object({ retryFailed: z.boolean().default(false) }).strict().parse(input);
  const modelIdentity = "local-keywords-no-model";
  await ensureQueue(trendRelevanceQueue.name, trendRelevanceQueue.options);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.trends.relevance.submit', 0))`;
    const signals = await db<Input["signal"][]>`SELECT s.id, s.platform, s.title, s.url FROM studio_trend_signals s
      LEFT JOIN studio_trend_relevance r ON r.signal_id = s.id AND r.context_key = s.relevance_key
      LEFT JOIN pgboss.job j ON j.name = ${trendRelevanceQueue.name} AND j.id = r.job_id
      WHERE r.signal_id IS NULL OR r.input->>'modelIdentity' <> ${modelIdentity} OR r.input->>'policy' <> ${policy}
        OR (r.state = 'superseded' AND r.result IS NULL AND (j.id IS NULL OR j.state IN ('failed', 'cancelled', 'completed')))
        OR (${query.retryFailed} AND r.result IS NULL AND (r.state = 'failed' OR j.id IS NULL OR j.state IN ('failed', 'cancelled', 'completed')))
      ORDER BY s.last_seen_at DESC, s.id LIMIT 200 FOR UPDATE OF s`;
    let queuedCount = 0;
    for (const signal of signals) {
      const snapshot: Input = { signal, audience: topicAudience, policy, modelIdentity };
      const key = sha256(stableJson(snapshot));
      const [existing] = await db<{ state: string; jobState: string | null; result: z.infer<typeof resultSchema> | null }[]>`SELECT r.state, j.state AS "jobState", r.result FROM studio_trend_relevance r
        LEFT JOIN pgboss.job j ON j.name = ${trendRelevanceQueue.name} AND j.id = r.job_id WHERE signal_id = ${signal.id} AND context_key = ${key}`;
      const retry = existing && !existing.result && (query.retryFailed || existing.state === "superseded")
        && (existing.jobState === null || ["failed", "cancelled", "completed"].includes(existing.jobState));
      if (existing && !retry) {
        await db`UPDATE studio_trend_signals SET relevance_key = ${key}, disposition = ${existing.result ? disposition(existing.result.decision) : "pending_relevance"} WHERE id = ${signal.id}`;
        continue;
      }
      const runToken = randomUUID();
      const jobId = await enqueueOn(trendRelevanceQueue, { signalId: signal.id, key, runToken },
        { singletonKey: `${signal.id}:${key}`, group: { id: "platform-trend-relevance" } }, db);
      if (!jobId) continue;
      await db`INSERT INTO studio_trend_relevance (signal_id, context_key, input, run_token, job_id)
        VALUES (${signal.id}, ${key}, ${db.json(snapshot)}, ${runToken}, ${jobId}) ON CONFLICT (signal_id, context_key)
        DO UPDATE SET run_token = EXCLUDED.run_token, job_id = EXCLUDED.job_id, state = 'queued', error = NULL, updated_at = now()`;
      await db`UPDATE studio_trend_signals SET relevance_key = ${key}, disposition = 'pending_relevance' WHERE id = ${signal.id}`;
      queuedCount++;
    }
    if (queuedCount) await audit(actor, "studio.trend.relevance", "trends", null, null, { queuedCount }, { db });
    return { queuedCount };
  });
}

export async function scheduleTrendRelevance() {
  return submitTrendRelevance({}, "system:studio.trends.relevance");
}

async function analyze(job: Job) {
  const [row] = await sql<{ input: Input; result: unknown }[]>`SELECT input, result FROM studio_trend_relevance
    WHERE signal_id = ${job.signalId} AND context_key = ${job.key} AND run_token = ${job.runToken}`;
  if (!row || row.result) return;
  if (row.input.policy !== policy) {
    await sql`UPDATE studio_trend_relevance SET state = 'superseded', updated_at = now()
      WHERE signal_id = ${job.signalId} AND context_key = ${job.key} AND run_token = ${job.runToken} AND result IS NULL`;
    return;
  }
  const matched = classifyTrendTitle(row.input.signal.title);
  const result = resultSchema.parse({ decision: matched.relevant ? "relevant" : "excluded", reason: matched.reason,
    titleQuote: row.input.signal.title, viewerProblem: matched.relevant ? "了解AI影视的新变化、作品与观看讨论；取得原文后再核实" : null });
  await sql.begin(async db => {
    const [current] = await db`SELECT id FROM studio_trend_signals WHERE id = ${job.signalId} AND relevance_key = ${job.key}
      AND title = ${row.input.signal.title} AND url = ${row.input.signal.url} FOR UPDATE`;
    if (!current) {
      await db`UPDATE studio_trend_relevance SET state='superseded',updated_at=now()
        WHERE signal_id=${job.signalId} AND context_key=${job.key} AND run_token=${job.runToken} AND result IS NULL`;
      return;
    }
    const saved = await db`UPDATE studio_trend_relevance SET state = 'completed', result = ${db.json(result)}, receipt_id = NULL,
      error = NULL, updated_at = now() WHERE signal_id = ${job.signalId} AND context_key = ${job.key} AND run_token = ${job.runToken} AND result IS NULL RETURNING signal_id`;
    if (saved.length) await db`UPDATE studio_trend_signals SET disposition = ${disposition(result.decision)} WHERE id = ${job.signalId} AND relevance_key = ${job.key}`;
  });
}
