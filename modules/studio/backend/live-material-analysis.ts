import { sql, type Db } from "@aihot/backend/db";
import { z } from "zod";
import { audit, Conflict } from "@aihot/backend/audit";
import { enqueueOn, ensureQueue, QueueDeferred } from "@aihot/backend/jobs/queue";
import { topicAnalysisQueue } from "./topic-material-analysis.ts";
import { analyzeMaterialEvidence, prepareMaterialAnalysis, materialAnalysisCachePolicy, type MaterialAnalysisSnapshot } from "./material-analysis.ts";
import { historyEvidenceKey } from "./history-entities.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { currentColumns, topicAudience } from "./topic-columns.ts";
import { topicPlan, topicDurationMs } from "./topic-plan.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { materialAnalysisReadings } from "./material-analysis-state.ts";
import { materialInsightPolicy } from "./material-insights.ts";
import type { TopicBatchMaterial } from "../contracts.ts";

export type LiveAnalysisJob = { materialId: string; sourceKey: string };
const materialIdSchema = z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/);

/** Private status only: never prepares work, reads full bodies or calls a model. */
export async function liveMaterialAnalysis(materialId: string) {
  materialIdSchema.parse(materialId);
  return sql.begin("isolation level repeatable read read only", async db => {
    return (await materialAnalysisReadings(db, [materialId], await modelWorkAllowed(db))).get(materialId) ?? null;
  });
}

/** Retry the persisted context, not whatever evidence happens to be current at recovery time. */
export async function retryLiveMaterialAnalysis(materialId: string, actor: string) {
  materialIdSchema.parse(materialId);
  if (!await modelWorkAllowed()) throw new Conflict("模型调用尚未启用，请先配置并启用模型服务");
  await ensureQueue(topicAnalysisQueue.name, topicAnalysisQueue.options);
  return sql.begin(async db => {
    const [source] = await db<{ sourceKey: string }[]>`SELECT knowledge->>'sourceKey' AS "sourceKey" FROM studio_history_index WHERE material_id = ${materialId}`;
    if (!source) return null;
    const [frozen] = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM studio_topic_batch_materials WHERE material_id = ${materialId}`;
    if (frozen && historyEvidenceKey(frozen.evidence) === source.sourceKey) throw new Conflict("同版材料已交给截止批次，请在批次内显式重试");
    const [row] = await db<{ state: string; snapshot: unknown; result: unknown; jobId: string | null }[]>`SELECT state, snapshot, result, job_id AS "jobId"
      FROM studio_live_material_analyses WHERE material_id = ${materialId} AND source_key = ${source.sourceKey} FOR UPDATE`;
    if (!row || row.result || !row.snapshot || row.state === "superseded") return { queued: false };
    const [active] = row.jobId ? await db`SELECT id FROM pgboss.job WHERE name = ${topicAnalysisQueue.name} AND id = ${row.jobId} AND state IN ('created', 'retry', 'active')` : [];
    if (active) return { queued: false };
    const jobId = await enqueueOn(topicAnalysisQueue, { live: { materialId, sourceKey: source.sourceKey } },
      { singletonKey: `live:${materialId}:${source.sourceKey}`, group: { id: "topic-material-analysis" } }, db);
    if (!jobId) return { queued: false };
    await db`UPDATE studio_live_material_analyses SET state = 'queued', job_id = ${jobId}, error = NULL, updated_at = now()
      WHERE material_id = ${materialId} AND source_key = ${source.sourceKey}`;
    await audit(actor, "studio.material.analysis.retry", materialId, null, null, { queued: true }, { db });
    return { queued: true };
  });
}

/** A new cutoff must inherit a terminal failure of the exact paid context. */
export async function liveMaterialTakeover(db: Db, context: MaterialAnalysisSnapshot, modelIdentity: string): Promise<"waiting" | "failed" | null> {
  const sourceKey = historyEvidenceKey(context.evidence);
  const [live] = await db<{ contextKey: string | null; snapshot: MaterialAnalysisSnapshot; jobState: string | null }[]>`
    SELECT l.context_key AS "contextKey", l.snapshot, j.state AS "jobState" FROM studio_live_material_analyses l
    LEFT JOIN pgboss.job j ON j.name = ${topicAnalysisQueue.name} AND j.id = l.job_id
    WHERE l.material_id = ${context.evidence.id} AND l.source_key = ${sourceKey} AND l.result IS NULL AND l.snapshot IS NOT NULL
    FOR UPDATE OF l`;
  if (!live) return null;
  const current = await prepareMaterialAnalysis(context, modelIdentity);
  const previousKey = live.contextKey ?? (await prepareMaterialAnalysis(live.snapshot, modelIdentity)).key;
  if (current.key !== previousKey) return null;
  // A completed model result can outlive a failed final business-row write.
  if ((await db`SELECT key FROM studio_material_analysis_cache WHERE key = ${current.key}`).length) return null;
  if (["created", "retry", "active"].includes(live.jobState ?? "missing")) return "waiting";
  await db`UPDATE studio_live_material_analyses SET state = 'superseded', updated_at = now()
    WHERE material_id = ${context.evidence.id} AND source_key = ${sourceKey}`;
  return "failed";
}

/** Reuse paid understanding at cutoff, even after a provider change. Exact semantic input and policy must still match. */
export async function completedLiveMaterialAnalysis(context: MaterialAnalysisSnapshot) {
  const sourceKey = historyEvidenceKey(context.evidence);
  const [live] = await sql<{ key: string; result: Awaited<ReturnType<typeof analyzeMaterialEvidence>>["result"]; receiptId: number; input: { analysisContext?: { modelIdentity?: string } } | null }[]>`
    SELECT l.context_key AS key, l.result, l.receipt_id::int AS "receiptId", c.input
    FROM studio_live_material_analyses l LEFT JOIN studio_shared_analysis_contexts c ON c.key = l.context_key
    WHERE l.material_id = ${context.evidence.id} AND l.source_key = ${sourceKey}
      AND l.state = 'completed' AND l.result IS NOT NULL AND l.receipt_id IS NOT NULL`;
  if (!live || context.sharedPolicy !== materialAnalysisCachePolicy) return null;
  // Column-only rematches keep the original understanding but need not create a shared-context row.
  // Recover bounded candidate identities; none is trusted until the ENTIRE target hash matches.
  const candidates = live.input ? [live.input] : (await sql<{ input: { analysisContext?: { modelIdentity?: string } } }[]>`
    SELECT c.input FROM studio_material_analysis_cache cache JOIN studio_shared_analysis_contexts c ON c.key = cache.key
    WHERE cache.source_key = ${sourceKey} ORDER BY cache.created_at DESC, cache.key LIMIT 12`).map(row => row.input);
  // This recomputes the full content/audience/column/insight/policy hash using its ORIGINAL provider identity.
  for (const candidate of candidates) {
    const previousIdentity = candidate.analysisContext?.modelIdentity;
    if (previousIdentity && (await prepareMaterialAnalysis(context, previousIdentity)).key === live.key)
      return { result: live.result, receiptId: live.receiptId };
  }
  return null;
}

/** Bounded outbox drain: source writes never initialize queues or call a model. */
export async function scheduleLiveMaterialAnalyses() {
  await ensureQueue(topicAnalysisQueue.name, topicAnalysisQueue.options);
  return sql.begin(async db => {
    const pending = await db<Array<LiveAnalysisJob & { collectedAt: Date; currentKey: string }>>`SELECT l.material_id AS "materialId",
      l.source_key AS "sourceKey", h.collected_at AS "collectedAt", h.knowledge->>'sourceKey' AS "currentKey"
      FROM studio_live_material_analyses l JOIN studio_history_index h ON h.material_id = l.material_id
      WHERE l.state = 'pending' ORDER BY l.requested_at, l.material_id, l.source_key LIMIT 50 FOR UPDATE OF l SKIP LOCKED`;
    if (!pending.length) return 0;
    const anchor = Date.parse((await topicPlan(db)).startsAt), columns = await currentColumns(db);
    let queued = 0;
    for (const item of pending) {
      // A closed batch owns this version and its explicit recovery policy. The live
      // outbox must never revive its failed/unknown paid request under a second task.
      const [frozen] = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM studio_topic_batch_materials WHERE material_id = ${item.materialId}`;
      if (frozen && historyEvidenceKey(frozen.evidence) === item.sourceKey) {
        await db`UPDATE studio_live_material_analyses SET state = 'superseded', updated_at = now()
          WHERE material_id = ${item.materialId} AND source_key = ${item.sourceKey}`;
        continue;
      }
      const startsAt = new Date(anchor + Math.floor((item.collectedAt.getTime() - anchor) / topicDurationMs) * topicDurationMs);
      const [row] = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db,
        { earliestStart: item.collectedAt, startsAt, endsAt: new Date(item.collectedAt.getTime() + 1) }, [item.materialId])}) materials`;
      if (item.currentKey !== item.sourceKey || !row || historyEvidenceKey(row.evidence) !== item.sourceKey) {
        await db`UPDATE studio_live_material_analyses SET state = 'superseded', updated_at = now()
          WHERE material_id = ${item.materialId} AND source_key = ${item.sourceKey}`;
        continue;
      }
      if (!["ok", "collected", "transcribed"].includes(row.evidence.bodyState) || !row.evidence.body.trim()) {
        await db`UPDATE studio_live_material_analyses SET state = 'waiting_body', updated_at = now()
          WHERE material_id = ${item.materialId} AND source_key = ${item.sourceKey}`;
        continue;
      }
      const snapshot: MaterialAnalysisSnapshot = { evidence: row.evidence, columns, audience: topicAudience, insightPolicy: materialInsightPolicy, sharedPolicy: materialAnalysisCachePolicy, requireChineseTitle: true };
      const jobId = await enqueueOn(topicAnalysisQueue, { live: { materialId: item.materialId, sourceKey: item.sourceKey } },
        { singletonKey: `live:${item.materialId}:${item.sourceKey}`, group: { id: "topic-material-analysis" } }, db);
      if (!jobId) continue;
      await db`UPDATE studio_live_material_analyses SET state = 'queued', snapshot = ${db.json(snapshot as never)}, job_id = ${jobId}, updated_at = now()
        WHERE material_id = ${item.materialId} AND source_key = ${item.sourceKey}`;
      queued++;
    }
    return queued;
  });
}

export async function analyzeLiveMaterial(job: LiveAnalysisJob) {
  const [row] = await sql<{ snapshot: MaterialAnalysisSnapshot | null; result: unknown }[]>`SELECT snapshot, result FROM studio_live_material_analyses
    WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey}`;
  if (row?.result) return;
  if (!row?.snapshot) throw new Error("采集中材料快照不存在");
  const prepared = await prepareMaterialAnalysis(row.snapshot);
  await sql`UPDATE studio_live_material_analyses SET state = 'running', error = NULL, context_key = ${prepared.key}, updated_at = now()
    WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey}`;
  try {
    const output = await analyzeMaterialEvidence(row.snapshot, undefined, prepared);
    await sql`UPDATE studio_live_material_analyses SET state = 'completed', result = ${sql.json(output.result)},
      receipt_id = ${output.receiptId}, error = NULL, snapshot = NULL, updated_at = now()
      WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND result IS NULL`;
  } catch (error) {
    const paused = error instanceof QueueDeferred;
    await sql`UPDATE studio_live_material_analyses SET state = ${paused ? "queued" : "failed"}, error = ${paused ? null : "分析未完成，可在模型配置和预算正常后重试"}, updated_at = now()
      WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND result IS NULL`;
    throw error;
  }
}
