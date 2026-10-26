import type { Db } from "@aihot/backend/db";

/** The ingestion transaction only records intent. No model, queue setup or second connection. */
export async function requestMaterialAnalysis(db: Db, materialId: string) {
  await db`INSERT INTO studio_live_material_analyses (material_id, source_key)
    SELECT material_id, knowledge->>'sourceKey' FROM studio_history_index WHERE material_id = ${materialId}
    ON CONFLICT (material_id, source_key) DO UPDATE SET state = 'pending', updated_at = now()
    WHERE studio_live_material_analyses.state = 'waiting_body'`;
}
