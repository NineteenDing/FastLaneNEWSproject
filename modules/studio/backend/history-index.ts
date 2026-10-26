import { z } from "zod";
import { type Db, withCustomPlans } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { HistoryCandidate, HistorySearch, MaterialEntity, TopicBatchMaterial } from "../contracts.ts";
import { historyAliases } from "./history-vocabulary.ts";
import { historyEntityPolicy, historyEvidenceKey } from "./history-entities.ts";
import { visibleCreatorPost } from "./creator-identity.ts";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const indexPolicy = { policy: "zh-word-v2", aliases: historyAliases, entities: historyEntityPolicy };
export const historyIndexPolicy = sha256(stableJson(indexPolicy));
export function historyTerms(text: string) {
  const normalized = normalize(text);
  const words = new Set(Array.from(segmenter.segment(normalized)).filter(item => item.isWordLike).map(item => item.segment));
  for (const aliases of historyAliases) {
    if (aliases.some(alias => /[\u3400-\u9fff]/.test(alias) ? normalized.includes(alias)
      : new RegExp(`(^|[^a-z0-9])${alias}($|[^a-z0-9])`, "u").test(normalized)))
      for (const alias of aliases) words.add(alias);
  }
  return [...words];
}

type IndexInput = { kind: HistoryCandidate["kind"]; title: string; url: string; body: string; publishedAt: Date | null; collectedAt: Date;
  contentVersion: HistoryCandidate["contentVersion"] };

/** Called inside the same transaction that saved the material; never reads other bodies. */
export async function indexHistoryMaterial(db: Db, id: string, extracted?: { sourceKey: string; entities: MaterialEntity[] }): Promise<boolean> {
  const creator = id.startsWith("creator:"), articleId = creator ? null : id.slice("news:".length), postId = creator ? id.slice("creator:".length) : null;
  const [row] = creator ? await db<IndexInput[]>`SELECT coalesce(p.content->>'kind', 'video') AS kind, p.content->>'title' AS title, p.content->>'url' AS url,
    coalesce(p.content->>'text', '') || coalesce(E'\n\n[本地转写]\n' || (t.result->>'text'), '') AS body,
    (p.content->>'publishedAt')::timestamptz AS "publishedAt", p.collected_at AS "collectedAt",
    jsonb_build_object('revision', NULL, 'fingerprint', p.content_fingerprint, 'transcriptSavedAt', t.saved_at) AS "contentVersion"
    FROM studio_creator_posts p LEFT JOIN studio_media_transcripts t ON t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint
    WHERE p.id = ${postId}` : await db<IndexInput[]>`SELECT 'news'::text AS kind, title, url, coalesce(body_text, excerpt, '') AS body,
    published_at AS "publishedAt", discovered_at AS "collectedAt",
    jsonb_build_object('revision', revision, 'fingerprint', content_hash) AS "contentVersion"
    FROM articles WHERE id = ${articleId}`;
  if (!row) return false;
  const sourceKey = historyEvidenceKey(row);
  if (extracted && extracted.sourceKey !== sourceKey) return false;
  const fingerprint = sha256(stableJson({ material: row, ...indexPolicy }));
  type Knowledge = { sourceKey: string; entities: MaterialEntity[] | null; policy: string };
  const [indexed] = await db<{ fingerprint: string; knowledge: Knowledge | null }[]>`SELECT fingerprint, knowledge FROM studio_history_index WHERE material_id = ${id}`;
  const knowledge: Knowledge = extracted ? { sourceKey, entities: extracted.entities, policy: historyEntityPolicy }
    : indexed?.knowledge?.sourceKey === sourceKey ? indexed.knowledge : { sourceKey, entities: null, policy: historyEntityPolicy };
  if (indexed?.fingerprint === fingerprint && stableJson(indexed.knowledge) === stableJson(knowledge)) return true;
  const names = knowledge.entities?.flatMap(entity => [entity.name, ...entity.aliases]) ?? [];
  await db`INSERT INTO studio_history_index (material_id, article_id, post_id, kind, title, normalized_title, url, excerpt, published_at, collected_at, content_version, fingerprint, terms, knowledge)
    VALUES (${id}, ${articleId}, ${postId}, ${row.kind}, ${row.title}, ${normalize(row.title)}, ${row.url}, ${row.body.slice(0, 180)}, ${row.publishedAt}, ${row.collectedAt},
      ${db.json(row.contentVersion)}, ${fingerprint}, ${historyTerms(row.title + "\n" + row.body + "\n" + names.join("\n"))}::text[], ${db.json(knowledge)})
    ON CONFLICT (material_id) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, normalized_title = EXCLUDED.normalized_title, url = EXCLUDED.url, excerpt = EXCLUDED.excerpt,
      published_at = EXCLUDED.published_at, collected_at = EXCLUDED.collected_at, content_version = EXCLUDED.content_version,
      fingerprint = EXCLUDED.fingerprint, terms = EXCLUDED.terms, knowledge = EXCLUDED.knowledge, updated_at = now()
    WHERE studio_history_index.fingerprint <> EXCLUDED.fingerprint OR studio_history_index.knowledge IS DISTINCT FROM EXCLUDED.knowledge`;
  return true;
}

/** Keep the source->index lock order used by ingestion and bounded rebuilds. */
export async function indexAnalyzedHistoryEntities(db: Db, material: TopicBatchMaterial, entities: MaterialEntity[]) {
  if (material.id.startsWith("news:")) await db`SELECT id FROM articles WHERE id = ${material.id.slice(5)} FOR UPDATE`;
  else await db`SELECT id FROM studio_creator_posts WHERE id = ${material.id.slice(8)}::uuid FOR UPDATE`;
  return indexHistoryMaterial(db, material.id, { sourceKey: historyEvidenceKey(material), entities });
}

/** Index-only candidates. Complete evidence is fetched only after selection, through its private ID. */
export async function historySearch(input: unknown): Promise<HistorySearch> {
  const query = z.object({ q: z.string().trim().min(1).max(200), before: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50) }).strict().parse(input);
  const wanted = historyTerms(query.q);
  if (!wanted.length) throw new z.ZodError([{ code: "custom", path: ["q"], message: "请输入可检索的关键词" }]);
  return withCustomPlans(async db => {
    const rows = await historyCandidates(db, { words: wanted, before: query.before, limit: query.limit, title: query.q });
    const [completed] = await db`SELECT id FROM studio_history_rebuild WHERE scope = 'all' AND policy = ${historyIndexPolicy} AND state = 'completed'`;
    return { rows, limit: query.limit, coverage: completed ? "backfilled" : "incremental_only" };
  });
}

/** A caller's transaction can share the candidate/body MVCC snapshot. No full bodies are read here. */
export async function historyCandidates(db: Db, query: { words: string[]; before?: string; limit: number; title?: string; exclude?: string[] }): Promise<HistoryCandidate[]> {
  const wanted = query.words, pattern = "%" + normalize(query.title ?? "").replace(/[\\%_]/g, "\\$&") + "%";
  const titleSearch = query.title !== undefined && Array.from(query.title).length >= 3;
  const rows = await db<Array<Omit<HistoryCandidate, "publishedAt" | "collectedAt" | "reason"> & { publishedAt: Date | null; collectedAt: Date }>>`
      SELECT h.material_id AS id, h.kind,
        h.title, h.url, h.excerpt, h.published_at AS "publishedAt",
        h.collected_at AS "collectedAt", h.content_version AS "contentVersion", h.fingerprint, h.knowledge->'entities' AS entities,
        jsonb_build_object('id', coalesce(s.id, c.id::text), 'name', coalesce(s.name, c.name, c.locator),
          'platform', coalesce(c.platform, 'news'), 'homepage', c.homepage, 'avatarUrl', NULL) AS source,
        ARRAY(SELECT word FROM unnest(h.terms) word WHERE word = ANY(${wanted}::text[]) ORDER BY word) AS "matchedTerms"
      FROM studio_history_index h LEFT JOIN articles a ON a.id = h.article_id LEFT JOIN sources s ON s.id = a.source_id
        LEFT JOIN studio_creator_posts p ON p.id = h.post_id LEFT JOIN studio_creator_accounts c ON c.id = p.creator_id
      WHERE (h.terms && ${wanted}::text[] OR (${titleSearch} AND h.normalized_title LIKE ${pattern}))
        AND (p.id IS NULL OR ${visibleCreatorPost(db)})
        AND NOT (h.material_id = ANY(${query.exclude ?? []}::text[]))
        AND (${query.before ?? null}::timestamptz IS NULL OR h.collected_at < ${query.before ?? null}::timestamptz)
      ORDER BY cardinality(ARRAY(SELECT word FROM unnest(h.terms) word WHERE word = ANY(${wanted}::text[]))) DESC,
        coalesce(h.published_at, h.collected_at) DESC, h.material_id LIMIT ${query.limit}`;
  return rows.map(row => ({ ...row, publishedAt: row.publishedAt?.toISOString() ?? null, collectedAt: row.collectedAt.toISOString(),
    reason: row.matchedTerms.length ? "匹配关键词或名称别名：" + row.matchedTerms.join("、") : "标题包含：" + query.title }));
}
