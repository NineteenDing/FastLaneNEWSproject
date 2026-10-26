import type { Tx } from "@aihot/backend/db";
import type { IntelligenceMatch, IntelligenceRow } from "../contracts.ts";
import { searchSnippet } from "../intelligence-search.ts";

/** Only the requested page's saved text is read, and only short matching context leaves PostgreSQL. */
export async function intelligenceMatches(db: Tx, rows: Pick<IntelligenceRow, "id" | "title" | "source">[], query: string) {
  const matches = new Map<string, IntelligenceMatch>();
  if (!query || !rows.length) return matches;
  for (const row of rows) for (const [field, value] of [["title", row.title], ["source", row.source.name]] as const) {
    const text = searchSnippet(value, query);
    if (text && !matches.has(row.id)) matches.set(row.id, { field, text });
  }
  const ids = rows.filter(row => !matches.has(row.id)).map(row => row.id);
  if (!ids.length) return matches;
  const news = ids.filter(id => id.startsWith("news:")).map(id => id.slice(5));
  const creators = ids.filter(id => id.startsWith("creator:")).map(id => id.slice(8));
  const saved = await db<Array<{ id: string; field: IntelligenceMatch["field"]; text: string }>>`
    WITH candidates AS (
      SELECT 'news:' || a.id AS id, 'body'::text AS field, a.body_text AS content FROM articles a WHERE a.id = ANY(${news}::text[])
      UNION ALL SELECT 'news:' || a.id, 'excerpt', a.excerpt FROM articles a WHERE a.id = ANY(${news}::text[])
      UNION ALL SELECT 'creator:' || p.id, 'body', p.content->>'text' FROM studio_creator_posts p WHERE p.id = ANY(${creators}::uuid[])
      UNION ALL SELECT 'creator:' || p.id, 'transcript', t.result->>'text' FROM studio_creator_posts p
        JOIN studio_media_transcripts t ON t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint WHERE p.id = ANY(${creators}::uuid[])
    ), hits AS (SELECT *, strpos(lower(content), lower(${query})) AS position FROM candidates)
    SELECT id, field, substring(content FROM greatest(1, position - 60) FOR char_length(${query}) + 160) AS text
    FROM hits WHERE position > 0 ORDER BY CASE field WHEN 'body' THEN 0 WHEN 'excerpt' THEN 1 ELSE 2 END`;
  for (const row of saved) {
    const text = searchSnippet(row.text, query);
    if (text && !matches.has(row.id)) matches.set(row.id, { field: row.field, text });
  }
  return matches;
}
