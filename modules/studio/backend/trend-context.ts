import type { Tx } from "@aihot/backend/db";

export type TrendContext = { signalId: string; key: string };
/** Short shared locks serialize publication with source pause and rule changes; no network in transaction. */
export async function trendContextAllowed(db: Tx, context: TrendContext) {
  const [settings] = await db`SELECT value FROM settings WHERE key = 'studio.trends.deep-read' FOR SHARE`;
  if (settings && !settings.value.enabled) return false;
  const [source] = await db`SELECT s.id FROM studio_trend_signals t JOIN studio_trend_boards b ON b.platform = t.platform
    JOIN sources s ON s.id = b.source_id WHERE t.id = ${context.signalId} AND s.enabled AND NOT s.archived FOR SHARE OF s`;
  if (!source) return false;
  // Collection locks source before signal. Keep the same order rather than locking both in a join.
  const [signal] = await db`SELECT t.id FROM studio_trend_signals t JOIN studio_trend_relevance r ON r.signal_id = t.id AND r.context_key = t.relevance_key
    WHERE t.id = ${context.signalId} AND t.relevance_key = ${context.key} AND r.state = 'completed'
      AND r.result->>'decision' = 'relevant' FOR SHARE OF t`;
  return !!signal;
}
