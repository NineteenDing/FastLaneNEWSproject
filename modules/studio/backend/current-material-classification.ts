import { sql } from "@aihot/backend/db";
import { z } from "zod";
import { audit, Conflict } from "@aihot/backend/audit";
import { ensureQueue, enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { topicAnalysisQueue } from "./topic-material-analysis.ts";
import { analyzeMaterialEvidence, prepareMaterialAnalysis, materialAnalysisCachePolicy, type MaterialAnalysisSnapshot } from "./material-analysis.ts";
import { materialAnalysisReadingsSql } from "./material-analysis-state.ts";
import { currentColumnContext } from "./column-matching.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { historyEvidenceKey } from "./history-entities.ts";
import { materialInsightPolicy } from "./material-insights.ts";
import { materialAnalysisModelIdentity } from "./studio-model.ts";
import { topicAudience } from "./topic-columns.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import type { TopicBatchMaterial } from "../contracts.ts";

export type ClassificationJob = { materialId: string; sourceKey: string; semanticsKey: string };
class Superseded extends Error {}

export async function retryCurrentMaterialClassification(materialId: string, input: unknown, actor: string) {
  z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/).parse(materialId); z.object({}).strict().parse(input);
  if (!await modelWorkAllowed()) throw new Conflict("模型调用尚未启用，请先配置并启用模型服务");
  await ensureQueue(topicAnalysisQueue.name, topicAnalysisQueue.options);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const columns = await currentColumnContext(db);
    const [row] = await db<{ sourceKey: string; result: unknown; snapshot: unknown; jobId: string | null }[]>`
      SELECT c.source_key AS "sourceKey", c.result, c.snapshot, c.job_id AS "jobId" FROM studio_current_material_classifications c
      JOIN studio_history_index h ON h.material_id = c.material_id AND h.knowledge->>'sourceKey' = c.source_key
      WHERE c.material_id = ${materialId} AND c.semantics_key = ${columns.key} FOR UPDATE OF c`;
    if (!row || row.result || !row.snapshot) return { queued: false };
    if (row.jobId && (await db`SELECT id FROM pgboss.job WHERE name = ${topicAnalysisQueue.name} AND id = ${row.jobId} AND state IN ('created', 'retry', 'active')`).length) return { queued: false };
    const job = { materialId, sourceKey: row.sourceKey, semanticsKey: columns.key };
    const jobId = await enqueueOn(topicAnalysisQueue, { classification: job }, { singletonKey: `classification:${materialId}:${row.sourceKey}:${columns.key}`,
      group: { id: "topic-material-analysis" } }, db);
    if (!jobId) return { queued: false };
    await db`UPDATE studio_current_material_classifications SET state = 'queued', job_id = ${jobId}, error = NULL, updated_at = now()
      WHERE material_id = ${materialId} AND source_key = ${row.sourceKey} AND semantics_key = ${columns.key}`;
    await audit(actor, "studio.material.classification.retry", materialId, null, null, { queued: true }, { db });
    return { queued: true };
  });
}

/** Current-only projection. Never rewrites a frozen batch, draft, facts or raw source. */
export async function scheduleCurrentMaterialClassifications() {
  await ensureQueue(topicAnalysisQueue.name, topicAnalysisQueue.options);
  const modelIdentity = await materialAnalysisModelIdentity(), now = new Date(), startsAt = new Date(now.getTime() - 48 * 3600000);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const columns = await currentColumnContext(db);
    const candidates = await db<Array<{ materialId: string; sourceKey: string }>>`SELECT h.material_id AS "materialId", h.knowledge->>'sourceKey' AS "sourceKey"
      FROM studio_history_index h CROSS JOIN LATERAL (SELECT h.material_id) indexed
      JOIN LATERAL (${materialAnalysisReadingsSql(db, db`h.material_id = indexed.material_id`, true)}) reading ON true
      WHERE h.collected_at >= ${startsAt} AND h.collected_at <= ${now} AND reading.state = 'completed'
        AND reading.result->'shared' IS NOT NULL AND reading.result->>'disposition' <> 'pending'
        AND reading.result->>'columnSemanticsKey' IS DISTINCT FROM ${columns.key}
        AND NOT EXISTS (SELECT 1 FROM studio_current_material_classifications c WHERE c.material_id = h.material_id
          AND c.source_key = h.knowledge->>'sourceKey' AND c.semantics_key = ${columns.key} AND c.state <> 'superseded')
      ORDER BY h.collected_at DESC, h.material_id LIMIT 25`;
    if (!candidates.length) return 0;
    const evidence = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db,
      { earliestStart: startsAt, startsAt, endsAt: new Date(now.getTime() + 1) }, candidates.map(row => row.materialId), true)}) materials`;
    let queued = 0;
    for (const candidate of candidates) {
      const material = evidence.find(row => row.evidence.id === candidate.materialId)?.evidence;
      if (!material || historyEvidenceKey(material) !== candidate.sourceKey || !["ok", "collected", "transcribed"].includes(material.bodyState)) continue;
      const snapshot: MaterialAnalysisSnapshot = { evidence: material, columns: columns.columns, audience: topicAudience, insightPolicy: materialInsightPolicy, sharedPolicy: materialAnalysisCachePolicy };
      const job = { materialId: candidate.materialId, sourceKey: candidate.sourceKey, semanticsKey: columns.key };
      const jobId = await enqueueOn(topicAnalysisQueue, { classification: job }, { singletonKey: `classification:${candidate.materialId}:${candidate.sourceKey}:${columns.key}`,
        group: { id: "topic-material-analysis" } }, db);
      if (!jobId) continue;
      await db`INSERT INTO studio_current_material_classifications (material_id, source_key, semantics_key, model_identity, state, snapshot, job_id)
        VALUES (${job.materialId}, ${job.sourceKey}, ${job.semanticsKey}, ${modelIdentity}, 'queued', ${db.json(snapshot as never)}, ${jobId})
        ON CONFLICT (material_id, source_key, semantics_key) DO UPDATE SET model_identity = EXCLUDED.model_identity,
          state = 'queued', snapshot = EXCLUDED.snapshot, job_id = EXCLUDED.job_id, error = NULL, updated_at = now()
        WHERE studio_current_material_classifications.state = 'superseded' AND studio_current_material_classifications.result IS NULL`;
      queued++;
    }
    return queued;
  });
}

export async function analyzeCurrentMaterialClassification(job: ClassificationJob) {
  const [row] = await sql<{ snapshot: MaterialAnalysisSnapshot | null; result: unknown; state: string; modelIdentity: string }[]>`
    SELECT snapshot, result, state, model_identity AS "modelIdentity" FROM studio_current_material_classifications
    WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND semantics_key = ${job.semanticsKey}`;
  if (row?.result || row?.state === "superseded") return;
  if (!row?.snapshot) throw new Error("当前栏目匹配快照不存在");
  async function current() {
    const [version] = await sql<{ sourceKey: string }[]>`SELECT knowledge->>'sourceKey' AS "sourceKey" FROM studio_history_index WHERE material_id = ${job.materialId}`;
    if (version?.sourceKey !== job.sourceKey || (await currentColumnContext(sql)).key !== job.semanticsKey) throw new Superseded("内容或栏目已更新");
  }
  try {
    await current();
    await sql`UPDATE studio_current_material_classifications SET state = 'running', error = NULL, updated_at = now()
      WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND semantics_key = ${job.semanticsKey}`;
    const prepared = await prepareMaterialAnalysis(row.snapshot, row.modelIdentity);
    const output = await analyzeMaterialEvidence(row.snapshot, `studio-current-classification:${job.materialId}:${job.semanticsKey}`, prepared, current);
    await sql`UPDATE studio_current_material_classifications SET state = 'completed', result = ${sql.json(output.result)}, receipt_id = ${output.receiptId}, snapshot = NULL, error = NULL, updated_at = now()
      WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND semantics_key = ${job.semanticsKey} AND result IS NULL`;
  } catch (error) {
    const stale = error instanceof Superseded, deferred = error instanceof QueueDeferred;
    await sql`UPDATE studio_current_material_classifications SET state = ${stale ? "superseded" : deferred ? "queued" : "failed"},
      error = ${stale || deferred ? null : "栏目匹配未完成，请检查模型和预算后重试"}, updated_at = now()
      WHERE material_id = ${job.materialId} AND source_key = ${job.sourceKey} AND semantics_key = ${job.semanticsKey} AND result IS NULL`;
    if (!stale) throw error;
  }
}
