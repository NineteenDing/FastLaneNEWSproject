// Adapt an already-understood occurrence to the engine's existing fact/story reading groups.
// This projection owns no inference and never calls a grouping model.
import type { Tx } from "../db.ts";
import type { PublicationJudgement } from "../modules.ts";
import { recordSignal } from "./signals.ts";

export async function projectSharedPublication(tx: Tx, articleId: string, event: PublicationJudgement["event"], at: Date) {
  const [manual] = await tx<{ fact_id: number; story_id: number | null }[]>`SELECT fa.fact_id, f.story_id
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE fa.article_id = ${articleId} AND fa.manual LIMIT 1`;
  if (manual) return manual;
  if ((await tx`SELECT 1 FROM grouping_overrides WHERE article_id = ${articleId}`).length) return null;
  if (!event) {
    await tx`DELETE FROM fact_articles WHERE article_id = ${articleId}`;
    return null;
  }
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'shared-public-event:' + event.rootId}, 0))`;
  const [story] = await tx<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at, origin)
    VALUES (${event.rootId}, ${event.title}, ${at}, ${at}, 'model')
    ON CONFLICT (public_id) DO UPDATE SET first_report_at = least(stories.first_report_at, EXCLUDED.first_report_at),
      latest_at = greatest(stories.latest_at, EXCLUDED.latest_at) RETURNING id`;
  const publicFactId = `shared-${event.id}`;
  await tx`INSERT INTO facts (public_id, story_id, title, occurred_at, first_report_at)
    VALUES (${publicFactId}, ${story!.id}, ${event.title}, ${event.occurredAt}, ${at})
    ON CONFLICT (public_id) DO UPDATE SET first_report_at = least(facts.first_report_at, EXCLUDED.first_report_at)`;
  const [fact] = await tx<{ id: number; story_id: number }[]>`SELECT id, story_id FROM facts WHERE public_id = ${publicFactId}`;
  // The current shared decision replaces legacy grouping, never frozen topic/draft evidence.
  await tx`DELETE FROM fact_articles WHERE article_id = ${articleId} AND fact_id <> ${fact!.id}`;
  await tx`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report') ON CONFLICT DO NOTHING`;
  const [source] = await tx<{ id: string; signal_group_id: string | null }[]>`SELECT s.id, s.signal_group_id FROM sources s
    JOIN articles a ON a.source_id = s.id WHERE a.id = ${articleId}`;
  if (source) await recordSignal(tx, fact!.story_id, articleId, source, "editorial", at);
  return { fact_id: fact!.id, story_id: fact!.story_id };
}
