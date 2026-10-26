import type { Tx } from "@aihot/backend/db";

/** Indexed relation to the saved discovery observation, not a live re-interpretation of a changed title. */
export function materialTrendsSql(db: Tx, postId: ReturnType<Tx>) {
  return db`SELECT coalesce(jsonb_agg(d.signal_snapshot ORDER BY d.created_at, d.signal_id), '[]'::jsonb) AS trends
    FROM studio_content_imports i JOIN studio_trend_deep_reads d ON d.import_id = i.id WHERE i.post_id = ${postId}`;
}
