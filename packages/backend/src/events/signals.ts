import type { Tx } from "../db.ts";

/** Original grouping signal writer, also used when a site supplies already-understood events. */
export async function recordSignal(db: Tx, storyId: number, articleId: string, source: { id: string; signal_group_id: string | null }, kind: "editorial" | "signal", observedAt: Date) {
  // Lock the story first so a concurrent merge makes a stale decision retry.
  const updated = await db`UPDATE stories SET latest_at = GREATEST(coalesce(latest_at, ${observedAt}), ${observedAt}),
              first_report_at = LEAST(coalesce(first_report_at, ${observedAt}), ${observedAt}), updated_at = now()
            WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!updated.count) throw new Error("Grouping target changed; retry against the current story");
  const participant = source.signal_group_id ? `group:${source.signal_group_id}` : `source:${source.id}`;
  await db`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${storyId}, ${articleId}, ${participant}, ${source.id}, ${kind}, ${observedAt})
    ON CONFLICT (story_id, article_id) DO NOTHING`;
}
