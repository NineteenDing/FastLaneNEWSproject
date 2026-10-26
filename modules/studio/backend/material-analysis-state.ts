import type { Db } from "@aihot/backend/db";
import type { MaterialAnalysisReading } from "../contracts.ts";
import { currentColumnContext, type ColumnContext } from "./column-matching.ts";

/** One metadata projection for page readings, counts and filters; source-version ownership stays identical. */
export async function materialAnalysisJobsAvailable(db: Db) {
  return (await db<{ ready: boolean }[]>`SELECT to_regclass('pgboss.job') IS NOT NULL AS ready`)[0]!.ready;
}
export function materialAnalysisReadingsSql(db: Db, where: ReturnType<Db>, jobsAvailable: boolean, columns?: ColumnContext) {
  const interrupted = db`candidate."rawState" IN ('queued', 'running') AND candidate.result IS NULL
    AND coalesce(job.state::text, 'missing') NOT IN ('created', 'retry', 'active')`;
  const base = db`SELECT candidate.*,
    CASE WHEN ${interrupted} THEN 'failed' ELSE coalesce(candidate."rawState", 'not_analyzed') END AS state,
    coalesce(candidate."rawError", CASE WHEN ${interrupted} THEN '分析任务已中断，可显式重试' END) AS error
    FROM (SELECT h.material_id AS "materialId", h.knowledge->>'sourceKey' AS "sourceKey",
      CASE WHEN a.material_id IS NOT NULL THEN a.state ELSE l.state END AS "rawState",
      CASE WHEN a.material_id IS NOT NULL THEN a.result ELSE l.result END AS result,
      CASE WHEN a.material_id IS NOT NULL THEN a.receipt_id ELSE l.receipt_id END::int AS "receiptId",
      CASE WHEN a.material_id IS NOT NULL THEN a.error ELSE l.error END AS "rawError",
      CASE WHEN a.material_id IS NOT NULL THEN a.job_id ELSE l.job_id END AS "jobId",
      CASE WHEN a.material_id IS NOT NULL THEN a.updated_at ELSE l.updated_at END AS "updatedAt",
      m.batch_id AS "batchId", coalesce(m.source_key = h.knowledge->>'sourceKey', false) AS "batchOwnsVersion",
      CASE WHEN a.material_id IS NOT NULL THEN 'batch' WHEN l.material_id IS NOT NULL THEN 'live' ELSE NULL END AS origin
    FROM studio_history_index h LEFT JOIN studio_live_material_analyses l
      ON l.material_id = h.material_id AND l.source_key = h.knowledge->>'sourceKey'
    LEFT JOIN studio_topic_batch_materials m ON m.material_id = h.material_id
    LEFT JOIN studio_topic_material_analyses a ON a.batch_id = m.batch_id AND a.material_id = m.material_id AND m.source_key = h.knowledge->>'sourceKey'
    WHERE ${where}) candidate LEFT JOIN ${jobsAvailable ? db`pgboss.job` : db`(SELECT NULL::uuid AS id, NULL::text AS name, NULL::text AS state)`} job
      ON job.name = 'studio.topic.material-analysis' AND job.id = candidate."jobId"`;
  if (!columns) return base;
  const interruptedClassification = db`c.result IS NULL AND c.state IN ('queued', 'running')
    AND coalesce(classification_job.state::text, 'missing') NOT IN ('created', 'retry', 'active')`;
  return db`SELECT original."materialId", original."sourceKey", original.state, original.error, original."updatedAt",
    original."batchId", original."batchOwnsVersion", original.origin, coalesce(c.result,
      CASE WHEN original.result->>'columnSemanticsKey' = ${columns.key} THEN original.result ELSE previous.result END, original.result) AS result,
    coalesce(c.receipt_id, CASE WHEN original.result->>'columnSemanticsKey' = ${columns.key} THEN original."receiptId" ELSE previous.receipt_id END, original."receiptId")::int AS "receiptId",
    CASE WHEN c.material_id IS NOT NULL THEN jsonb_build_object('key', ${columns.key}::text,
      'state', CASE WHEN ${interruptedClassification} THEN 'failed' ELSE c.state END,
      'error', coalesce(c.error, CASE WHEN ${interruptedClassification} THEN '栏目匹配任务已中断，可显式重试' END), 'updatedAt', c.updated_at)
    WHEN original.result->'shared' IS NOT NULL AND original.result->>'columnSemanticsKey' IS DISTINCT FROM ${columns.key}
      THEN jsonb_build_object('key', ${columns.key}::text, 'state', 'pending', 'error', NULL, 'updatedAt', NULL) ELSE NULL END AS classification
    FROM (${base}) original LEFT JOIN studio_current_material_classifications c ON c.material_id = original."materialId"
      AND c.source_key = original."sourceKey" AND c.semantics_key = ${columns.key}
    LEFT JOIN LATERAL (SELECT old.result, old.receipt_id FROM studio_current_material_classifications old
      WHERE old.material_id = original."materialId" AND old.source_key = original."sourceKey" AND old.result IS NOT NULL
      ORDER BY old.updated_at DESC, old.semantics_key LIMIT 1) previous ON true
    LEFT JOIN ${jobsAvailable ? db`pgboss.job` : db`(SELECT NULL::uuid AS id, NULL::text AS name, NULL::text AS state)`} classification_job
      ON classification_job.name = 'studio.topic.material-analysis' AND classification_job.id = c.job_id`;
}

/** Read only the requested identities and matching source versions, never bodies or model services. */
export async function materialAnalysisReadings(db: Db, ids: string[], modelEnabled: boolean, jobsAvailable?: boolean) {
  const readings = new Map<string, MaterialAnalysisReading>();
  if (!ids.length) return readings;
  const columns = await currentColumnContext(db);
  const rows = await db<Array<{ materialId: string; sourceKey: string | null; state: MaterialAnalysisReading["state"];
    result: MaterialAnalysisReading["result"]; receiptId: number | null; error: string | null; updatedAt: Date | null;
    batchId: string | null; batchOwnsVersion: boolean; origin: MaterialAnalysisReading["origin"]; classification: MaterialAnalysisReading["classification"] }>>`${materialAnalysisReadingsSql(db, db`h.material_id = ANY(${ids}::text[])`, jobsAvailable ?? await materialAnalysisJobsAvailable(db), columns)}`;
  for (const row of rows) {
    const column = row.result?.columnSemanticsKey === columns.key ? columns.columns.find(column => column.id === row.result!.columnId) : null;
    const result = row.result && column ? { ...row.result, columnSnapshot: { id: column.id, name: column.name, version: column.version } } : row.result;
    readings.set(row.materialId, { materialId: row.materialId, sourceKey: row.sourceKey, state: row.state,
      result, receiptId: row.receiptId, error: row.error, ...(row.classification ? { classification: row.classification } : {}),
      updatedAt: row.updatedAt?.toISOString() ?? null, modelEnabled, batchId: row.batchId, batchOwnsVersion: row.batchOwnsVersion, origin: row.origin });
  }
  return readings;
}
