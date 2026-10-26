import type { Db } from "@aihot/backend/db";

/** Revisions share the root's immutable evidence; ownership/late-arrival dedup remains unique. */
export function batchEvidence(db: Db, batchId?: string) {
  const where = batchId === undefined ? db`true` : db`b.id = ${batchId}`;
  return db`SELECT b.id AS batch_id, m.material_id, m.collected_at, m.evidence, m.source_key
    FROM studio_topic_batches b JOIN studio_topic_batch_materials m ON m.batch_id = coalesce(b.root_batch_id, b.id)
    WHERE ${where} AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b.supplemental_materials) extra WHERE extra->>'id' = m.material_id)
    UNION ALL SELECT b.id AS batch_id, extra->>'id' AS material_id, (extra->>'collectedAt')::timestamptz AS collected_at, extra AS evidence, NULL::text AS source_key
    FROM studio_topic_batches b, jsonb_array_elements(b.supplemental_materials) extra WHERE ${where}`;
}
