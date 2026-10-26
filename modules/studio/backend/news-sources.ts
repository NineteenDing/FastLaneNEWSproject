import { sql } from "@aihot/backend/db";
import { z } from "zod";
import { budgetMessage } from "@aihot/backend/providers/receipts";
import type { NewsSourceCard, NewsSources } from "../contracts.ts";
import { matchesSourceMetadata } from "./metadata-sql.ts";

type SourceRow = Omit<NewsSourceCard, "lastCheckedAt" | "latestPublishedAt" | "addedAt" | "version"> & {
  lastCheckedAt: Date | null;
  latestPublishedAt: Date | null;
  addedAt: Date;
  version: Date;
};

/** Read existing identities without starting a second collector or disclosing its credentials. */
export async function newsSources(query: unknown): Promise<NewsSources> {
  const f = z.object({
    q: z.string().trim().max(200).default(""),
    enabled: z.enum(["true", "false"]).optional(),
    archived: z.enum(["true", "false"]).default("false"),
    region: z.string().trim().min(1).max(80).optional(),
    regionMissing: z.literal("true").optional(),
    excludeTrends: z.literal("true").optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }).strict().refine(value => !(value.region && value.regionMissing), "请选择具体地区或地区待补充").parse(query);
  const pattern = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
  const enabled = f.enabled === undefined ? null : f.enabled === "true";
  return await sql.begin("isolation level repeatable read read only", async (db) => {
    const baseWhere = db`(${pattern} = '%%' OR s.name ILIKE ${pattern} OR s.id ILIKE ${pattern})
      AND s.archived = ${f.archived === "true"}
      AND (${enabled}::boolean IS NULL OR s.enabled = ${enabled})
      AND (${f.excludeTrends === "true"} = FALSE OR NOT EXISTS (SELECT 1 FROM studio_trend_boards WHERE source_id = s.id))`;
    const where = db`${baseWhere}
      AND (${f.region ?? null}::text IS NULL OR profile.region = ${f.region ?? null})
      AND (${f.regionMissing === "true"} = FALSE OR profile.region IS NULL)`;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM sources s
      LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id WHERE ${where}`;
    const regionOptions = await db<NewsSources["regionOptions"]>`SELECT profile.region, count(*)::int AS count
      FROM sources s LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
      WHERE ${baseWhere} GROUP BY profile.region ORDER BY profile.region COLLATE "C" NULLS LAST`;
    const rows = await db<SourceRow[]>`
    SELECT s.id, s.name, s.kind, s.tags, s.enabled, s.archived, s.health,
      s.last_ok_at AS "lastCheckedAt", s.created_at AS "addedAt", s.updated_at AS version, s.failure_warning AS "failureWarning",
      stats."latestPublishedAt", stats."collectedCount",
      CASE WHEN 'description' = ANY(profile.manual_fields) THEN profile.description ELSE metadata.description END AS description, profile.region,
      CASE WHEN 'language' = ANY(profile.manual_fields) THEN profile.language ELSE metadata.language END AS language,
      CASE WHEN 'homepage' = ANY(profile.manual_fields) THEN profile.homepage ELSE metadata.homepage END AS homepage,
      CASE WHEN metadata.icon_key IS NULL THEN NULL ELSE '/api/admin/studio/news-sources/' || s.id || '/avatar?v=' || metadata.icon_key END AS "avatarUrl",
      CASE WHEN metadata.source_id IS NULL THEN NULL ELSE jsonb_build_object('state', metadata.state, 'checkedAt', metadata.checked_at, 'iconState', metadata.icon_state) END AS metadata,
      COALESCE(profile.version, 0) AS "profileVersion",
      CASE WHEN checked.source_id IS NULL THEN NULL ELSE jsonb_build_object(
        'state', checked.state, 'checkedAt', checked.checked_at, 'itemCount', checked.item_count) END AS validation
    FROM (SELECT s.*, CASE WHEN s.enabled AND NOT s.archived AND s.fail_count >= 3
        AND failures.latest - failures.first >= interval '48 hours' THEN jsonb_build_object(
          'count', s.fail_count, 'firstFailedAt', failures.first, 'lastFailedAt', failures.latest) END AS failure_warning
      FROM sources s LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
      LEFT JOIN LATERAL (SELECT min(recent.started_at) AS first, max(recent.finished_at) AS latest FROM (
        SELECT started_at, finished_at FROM fetch_runs WHERE source_id = s.id AND status = 'failed'
          AND finished_at > coalesce(s.last_ok_at, s.created_at) AND error IS DISTINCT FROM 'login_required'
          AND coalesce(error, '') NOT LIKE ${budgetMessage("%", "%")}
          AND s.fail_count >= 3 ORDER BY started_at DESC, id DESC LIMIT LEAST(s.fail_count, 1000)
      ) recent) failures ON true
      WHERE ${where} ORDER BY s.enabled DESC, (s.enabled AND NOT s.archived AND s.fail_count >= 3
        AND failures.latest - failures.first >= interval '48 hours') DESC NULLS LAST, s.name, s.id
      LIMIT ${f.limit} OFFSET ${(f.page - 1) * f.limit}) s
    LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
    LEFT JOIN studio_source_metadata metadata ON metadata.source_id = s.id AND ${matchesSourceMetadata(db)}
    LEFT JOIN studio_source_checks checked ON checked.source_id = s.id AND checked.config_fingerprint = md5(s.kind || ':' || s.config::text)
    CROSS JOIN LATERAL (
      SELECT max(a.published_at) AS "latestPublishedAt", count(*)::int AS "collectedCount"
      FROM articles a JOIN (
        SELECT article_id FROM article_discoveries WHERE source_id = s.id
        UNION SELECT id FROM articles WHERE source_id = s.id
      ) seen ON seen.article_id = a.id
    ) stats ORDER BY s.enabled DESC, (s.failure_warning IS NOT NULL) DESC, s.name, s.id`;
    return { total, page: f.page, hasMore: f.page * f.limit < total, regionOptions, rows: rows.map((row) => ({ ...row,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      latestPublishedAt: row.latestPublishedAt?.toISOString() ?? null,
      addedAt: row.addedAt.toISOString(), version: row.version.toISOString(),
    })) };
  }) as NewsSources;
}
