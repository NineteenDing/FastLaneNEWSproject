import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import type { IntelligenceDates, IntelligenceDetail, IntelligenceList, IntelligenceRow } from "../contracts.ts";
import { matchesSourceMetadata } from "./metadata-sql.ts";
import { materialAnalysisReadings, materialAnalysisReadingsSql, materialAnalysisJobsAvailable } from "./material-analysis-state.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { sourceImages } from "./source-images.ts";
import { materialTrendsSql } from "./trend-provenance.ts";
import { visibleCreatorPost } from "./creator-identity.ts";
import { creatorWorkSource } from "./creator-works.ts";
import { intelligenceMatches } from "./intelligence-matches.ts";
import { currentColumnContext, type ColumnContext } from "./column-matching.ts";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";

type Row = Omit<IntelligenceRow, "publishedAt" | "collectedAt" | "updatedAt" | "analysisState"> & {
  publishedAt: Date | null; collectedAt: Date; updatedAt: Date;
};

/** A private read projection over the existing stores, never the public selection pool. */
function materialRows(db: Tx, filter: { q?: string; kind?: string; platform?: string; ids?: string[]; origin?: string } = {}) {
  const pattern = `%${(filter.q ?? "").replace(/[\\%_]/g, "\\$&")}%`;
  return db`
    SELECT 'news:' || a.id AS id, 'news'::text AS kind, a.title,
      left(coalesce(nullif(a.excerpt, ''), a.body_text, ''), 180) AS excerpt,
      a.published_at AS "publishedAt", a.discovered_at AS "collectedAt", a.updated_at AS "updatedAt",
      jsonb_build_object('id', s.id, 'name', s.name, 'platform', 'news',
        'reporterId', coalesce('entity:' || s.owner_entity_id, 'group:' || s.signal_group_id, 'source:' || s.id),
        'homepage', CASE WHEN 'homepage' = ANY(profile.manual_fields) THEN profile.homepage ELSE metadata.homepage END,
        'avatarUrl', CASE WHEN metadata.icon_key IS NULL THEN NULL ELSE '/api/admin/studio/news-sources/' || s.id || '/avatar?v=' || metadata.icon_key END) AS source,
      NULL::jsonb AS metrics, a.processing_state AS "processingState"
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
    LEFT JOIN studio_source_metadata metadata ON metadata.source_id = s.id AND ${matchesSourceMetadata(db)}
    WHERE (${filter.kind ?? null}::text IS NULL OR ${filter.kind ?? null} = 'news')
      AND ${filter.origin ? db`false` : db`true`}
      AND ${filter.ids === undefined ? db`true` : db`a.id = ANY(${filter.ids.filter(id => id.startsWith("news:")).map(id => id.slice(5))}::text[])`}
      AND (${filter.platform ?? null}::text IS NULL OR ${filter.platform ?? null} = 'news')
      AND (${pattern} = '%%' OR a.title ILIKE ${pattern} OR a.excerpt ILIKE ${pattern} OR a.body_text ILIKE ${pattern} OR s.name ILIKE ${pattern})
    UNION ALL
    SELECT 'creator:' || p.id AS id, coalesce(p.content->>'kind', 'video') AS kind,
      p.content->>'title' AS title, left(coalesce(p.content->>'text', ''), 180) AS excerpt,
      (p.content->>'publishedAt')::timestamptz AS "publishedAt", p.collected_at AS "collectedAt", p.updated_at AS "updatedAt",
      jsonb_build_object('id', c.id, 'name', coalesce(c.name, c.locator), 'platform', c.platform,
        'homepage', c.homepage, 'avatarUrl', (SELECT '/api/admin/studio/creators/' || c.id || '/avatar?v=' || image_id
          FROM studio_image_references WHERE owner = 'creator-avatar:' || c.id LIMIT 1))
        || CASE WHEN subject.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('subject', jsonb_build_object('id', subject.id, 'name', subject.name)) END
        || ${creatorWorkSource(db, db`p.id`)} AS source,
      p.content->'metrics' AS metrics, CASE WHEN t.post_id IS NOT NULL THEN 'transcribed' ELSE 'collected' END AS "processingState"
    FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id
    LEFT JOIN studio_creator_subject_accounts member ON member.account_id = c.id
    LEFT JOIN studio_creator_subjects subject ON subject.id = member.subject_id
    LEFT JOIN studio_media_transcripts t ON t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint
    WHERE (${filter.kind ?? null}::text IS NULL OR coalesce(p.content->>'kind', 'video') = ${filter.kind ?? null})
      AND ${filter.ids === undefined ? visibleCreatorPost(db) : db`true`}
      AND ${filter.origin === "trends" ? db`EXISTS (SELECT 1 FROM studio_content_imports ci JOIN studio_trend_deep_reads d ON d.import_id = ci.id WHERE ci.post_id = p.id)` : db`true`}
      AND ${filter.ids === undefined ? db`true` : db`p.id = ANY(${filter.ids.filter(id => id.startsWith("creator:")).map(id => id.slice(8))}::uuid[])`}
      AND (${filter.platform ?? null}::text IS NULL OR c.platform = ${filter.platform ?? null})
      AND (${pattern} = '%%' OR p.content->>'title' ILIKE ${pattern} OR p.content->>'text' ILIKE ${pattern} OR t.result->>'text' ILIKE ${pattern} OR c.name ILIKE ${pattern} OR c.locator ILIKE ${pattern})`;
}

/** Complete private evidence for a closed collection window; no list excerpt or observation limit. */
export function intelligenceEvidence(db: Tx, window: { earliestStart: Date; startsAt: Date; endsAt: Date }, ids?: string[], selectedOutsideWindow = false) {
  return db`WITH materials AS (${materialRows(db, { ids })}) SELECT m.id, m."collectedAt",
    to_jsonb(m) || jsonb_build_object('analysisState', 'not_connected',
      'freshness', CASE WHEN m."publishedAt" IS NULL THEN 'undated'
        WHEN coalesce(a.backfill, false) OR m."publishedAt" < ${window.startsAt} THEN 'background' ELSE 'current' END,
      'arrivedLate', m."collectedAt" < ${window.startsAt},
      'contentVersion', jsonb_build_object('revision', a.revision, 'fingerprint', coalesce(a.content_hash, p.content_fingerprint)),
      'url', coalesce(a.url, p.content->>'url'),
      'body', CASE WHEN a.id IS NOT NULL THEN coalesce(a.body_text, a.excerpt, '') ELSE coalesce(p.content->>'text', '') ||
        CASE WHEN transcript.post_id IS NOT NULL THEN E'\n\n[本地转写]\n' || (transcript.result->>'text') ELSE '' END END,
      'bodyState', CASE WHEN a.id IS NOT NULL THEN a.body_status WHEN transcript.post_id IS NOT NULL THEN 'transcribed'
        WHEN coalesce(p.content->>'kind', 'video') = 'video' THEN 'not_transcribed' ELSE 'collected' END,
      'transcript', transcript.result || jsonb_build_object('mediaState', CASE WHEN transcript.workspace_id IS NULL THEN 'cleaned' ELSE 'cleanup_pending' END),
      'comments', CASE WHEN a.id IS NOT NULL THEN '[]'::jsonb ELSE coalesce(p.content->'comments', '[]'::jsonb) END,
      'commentCoverage', p.content->'commentCoverage', 'parent', p.content->'parent',
      'observations', coalesce((SELECT jsonb_agg(jsonb_build_object('observedAt', o.observed_at, 'metrics', o.metrics) ORDER BY o.observed_at, o.id)
        FROM studio_creator_observations o WHERE o.post_id = p.id), '[]'::jsonb))
      || CASE WHEN images.version_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceImages', jsonb_build_object(
        'versionKey', images.version_key, 'revision', images.revision, 'state', CASE WHEN jsonb_array_length(images.candidates) = 0 THEN 'empty' ELSE images.state END,
        'enabled', false, 'candidateCount', jsonb_array_length(images.candidates), 'images', images.images, 'error', images.error, 'updatedAt', images.updated_at)) END
      || CASE WHEN trends.trends <> '[]'::jsonb THEN jsonb_build_object('trends', trends.trends) ELSE '{}'::jsonb END AS evidence
    FROM materials m LEFT JOIN articles a ON a.id = CASE WHEN m.id LIKE 'news:%' THEN substring(m.id FROM 6) END
    LEFT JOIN studio_creator_posts p ON p.id = CASE WHEN m.id LIKE 'creator:%' THEN substring(m.id FROM 9)::uuid END
    LEFT JOIN studio_media_transcripts transcript ON transcript.post_id = p.id AND transcript.source_fingerprint = p.content_fingerprint
    LEFT JOIN LATERAL (SELECT i.* FROM studio_news_image_sets i WHERE i.article_id = a.id AND i.revision = a.revision ORDER BY i.updated_at DESC LIMIT 1) images ON true
    LEFT JOIN LATERAL (${materialTrendsSql(db, db`p.id`)}) trends ON p.id IS NOT NULL
    WHERE ${selectedOutsideWindow && ids?.length ? db`true` : db`m."collectedAt" >= ${window.earliestStart} AND m."collectedAt" < ${window.endsAt}`}`;
}

function project(row: Row): IntelligenceRow {
  return { ...row, publishedAt: row.publishedAt?.toISOString() ?? null, collectedAt: row.collectedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(), analysisState: "not_connected" };
}

/** Apply analysis metadata before paging/date aggregation; no model execution or per-page post-filter. */
function filteredMaterialRows(db: Tx, filter: Parameters<typeof materialRows>[1] & { analysisState?: string; column?: string }, jobsAvailable: boolean, columns: ColumnContext) {
  const base = materialRows(db, filter);
  if (!filter?.analysisState && !filter?.column) return base;
  return db`SELECT listed.* FROM (${base}) listed LEFT JOIN LATERAL
    (${materialAnalysisReadingsSql(db, db`h.material_id = listed.id`, jobsAvailable, columns)}) reading ON true
    WHERE ${!filter.analysisState ? db`true` : filter.analysisState === "pending" ? db`coalesce(reading.state, 'not_analyzed') IN ('pending', 'not_analyzed')`
      : db`coalesce(reading.state, 'not_analyzed') = ${filter.analysisState}`}
      AND ${!filter.column ? db`true` : filter.column === "unclassified" ? db`reading.result->>'columnId' IS NULL` : db`reading.result->>'columnId' = ${filter.column}`}`;
}

const filters = z.object({ q: z.string().trim().max(200).default(""),
    column: z.string().trim().min(1).max(100).optional(),
    analysisState: z.enum(["not_analyzed", "pending", "waiting_body", "queued", "running", "completed", "failed", "superseded"]).optional(),
    origin: z.enum(["trends", "creators"]).optional(),
    kind: z.enum(["news", "video", "post", "image_text", "answer", "article"]).optional(),
    platform: z.enum(["news", "bilibili", "weibo", "xhs", "zhihu", "tieba", "douyin", "kuaishou"]).optional(),
    basis: z.enum(["collected", "published"]).default("collected") });

export async function intelligenceList(input: unknown): Promise<IntelligenceList> {
  const query = filters.extend({
    recent: z.enum(["24h", "today"]).optional(),
    day: z.union([z.iso.date().refine(value => value >= "0001-01-01"), z.literal("undated")]).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30) }).strict()
    .refine(query => query.day !== "undated" || query.basis === "published").parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const time = query.basis === "published" ? db`"publishedAt"` : db`"collectedAt"`;
    const jobsAvailable = query.analysisState || query.column ? await materialAnalysisJobsAvailable(db) : undefined;
    const columns = await currentColumnContext(db);
    const now = new Date();
    const day = query.recent === "today" ? db`"collectedAt" >= ${beijingMidnight(beijingDate(now))} AND "collectedAt" <= ${now}`
      : query.recent ? db`"collectedAt" >= ${new Date(now.getTime() - 24 * 3600000)} AND "collectedAt" <= ${now}` : !query.day ? db`true` : query.day === "undated" ? db`${time} IS NULL`
      : db`${time} >= (${query.day}::date::timestamp AT TIME ZONE 'Asia/Hong_Kong')
        AND ${time} < ((${query.day}::date + 1)::timestamp AT TIME ZONE 'Asia/Hong_Kong')`;
    const [{ total }] = await db<{ total: number }[]>`WITH materials AS (${filteredMaterialRows(db, query, jobsAvailable ?? false, columns)}) SELECT count(*)::int AS total FROM materials WHERE ${day}`;
    const rows = await db<Row[]>`WITH materials AS (${filteredMaterialRows(db, query, jobsAvailable ?? false, columns)}) SELECT * FROM materials
      WHERE ${day} ORDER BY ${time} DESC NULLS LAST, id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    const analyses = await materialAnalysisReadings(db, rows.map(row => row.id), await modelWorkAllowed(db), jobsAvailable);
    const matches = await intelligenceMatches(db, rows, query.q);
    return { rows: rows.map(row => ({ ...project(row), analysisState: analyses.get(row.id)?.state ?? "not_analyzed", ...(matches.has(row.id) ? { match: matches.get(row.id)! } : {}) })), total, page: query.page, hasMore: query.page * query.limit < total };
  }) as Promise<IntelligenceList>;
}

export async function intelligenceDates(input: unknown): Promise<IntelligenceDates> {
  const query = filters.extend({ month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const time = query.basis === "published" ? db`"publishedAt"` : db`"collectedAt"`;
    const jobsAvailable = query.analysisState || query.column ? await materialAnalysisJobsAvailable(db) : false;
    const columns = await currentColumnContext(db);
    const months = await db<{ month: string; total: number }[]>`WITH materials AS (${filteredMaterialRows(db, query, jobsAvailable, columns)})
      SELECT to_char(${time} AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM') AS month, count(*)::int AS total
      FROM materials WHERE ${time} IS NOT NULL GROUP BY 1 ORDER BY 1 DESC`;
    const month = query.month ?? months[0]?.month ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).format(new Date());
    const days = await db<{ day: string; total: number }[]>`WITH materials AS (${filteredMaterialRows(db, query, jobsAvailable, columns)})
      SELECT to_char(${time} AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM-DD') AS day, count(*)::int AS total
      FROM materials WHERE ${time} >= ((${month} || '-01')::date::timestamp AT TIME ZONE 'Asia/Hong_Kong')
        AND ${time} < (((${month} || '-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Hong_Kong')
      GROUP BY 1 ORDER BY 1 DESC`;
    const [{ total: undatedTotal }] = await db<{ total: number }[]>`WITH materials AS (${filteredMaterialRows(db, query, jobsAvailable, columns)}) SELECT count(*)::int AS total FROM materials WHERE ${time} IS NULL`;
    return { basis: query.basis, month, months, days, undatedTotal };
  }) as Promise<IntelligenceDates>;
}

/** Retains the two existing source identities; neither read publishes private content. */
export async function intelligenceDetail(id: string): Promise<IntelligenceDetail | null> {
  const key = z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/).parse(id);
  const externalId = key.slice(key.indexOf(":") + 1);
  const creator = key.startsWith("creator:");
  if (creator) z.uuid().parse(externalId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [row] = await db<Row[]>`WITH materials AS (${materialRows(db, { ids: [key] })}) SELECT * FROM materials WHERE id = ${key}`;
    if (!row) return null;
    const analysis = (await materialAnalysisReadings(db, [key], await modelWorkAllowed(db))).get(key) ?? null;
    const projected = { ...project(row), analysis, analysisState: analysis?.state ?? "not_analyzed" as const };
    if (!creator) {
      const [body] = await db<{ url: string; body: string; bodyState: string }[]>`SELECT url,
        coalesce(body_text, excerpt, '') AS body, body_status AS "bodyState" FROM articles WHERE id = ${externalId}`;
      return { ...projected, ...body!, comments: [], commentCoverage: null, observations: [], parent: null, sourceImages: (await sourceImages(key, db))! };
    }
    const [body] = await db<Pick<IntelligenceDetail, "url" | "body" | "bodyState" | "comments" | "commentCoverage" | "parent" | "transcript">[]>`
      SELECT p.content->>'url' AS url, coalesce(p.content->>'text', '') AS body,
        CASE WHEN t.post_id IS NOT NULL THEN 'transcribed' WHEN coalesce(p.content->>'kind', 'video') = 'video' THEN 'not_transcribed' ELSE 'collected' END AS "bodyState",
        p.content->'comments' AS comments, p.content->'commentCoverage' AS "commentCoverage", p.content->'parent' AS parent,
        t.result || jsonb_build_object('mediaState', CASE WHEN t.workspace_id IS NULL THEN 'cleaned' ELSE 'cleanup_pending' END) AS transcript
      FROM studio_creator_posts p LEFT JOIN studio_media_transcripts t ON t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint WHERE p.id = ${externalId}`;
    const observations = await db<{ observedAt: Date; metrics: IntelligenceDetail["observations"][number]["metrics"] }[]>`
      SELECT observed_at AS "observedAt", metrics FROM studio_creator_observations WHERE post_id = ${externalId}
      ORDER BY observed_at DESC, id DESC LIMIT 100`;
    const [trends] = await db`${materialTrendsSql(db, db`${externalId}::uuid`)}`;
    return { ...projected, ...body!, ...(trends?.trends.length ? { trends: trends.trends } : {}), observations: observations.reverse().map(item => ({ ...item, observedAt: item.observedAt.toISOString() })) };
  }) as Promise<IntelligenceDetail | null>;
}
