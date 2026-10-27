import { savedNewsTitle } from "./news-titles.ts";
import { sql, type Db } from "@aihot/backend/db";
import type { PublicationJudgement } from "@aihot/backend/modules";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { emit } from "@aihot/backend/modules";
import { currentFilterPolicy } from "./filter-settings.ts";
import { scoringRecords, scoreMaterialV2 } from "./filter-scoring.ts";
import { currentColumnContext } from "./column-matching.ts";
import { sharedEventObservations } from "./shared-events.ts";
import { publicSummaryState } from "./shared-material.ts";
import * as cheerio from "cheerio";

type PublicNewsDecision = PublicationJudgement & { images: string[]; fulltextImages: string[] };

/** Old reports and periodic editions have no approval in this daily-only site. */
export function publicReportCondition(alias: string): ReturnType<typeof sql> {
  return sql`${sql(alias)}.kind = 'daily' AND EXISTS (SELECT 1 FROM studio_public_reports report_permission
    WHERE report_permission.report_id = ${sql(alias)}.id AND report_permission.revision = ${sql(alias)}.revision
      AND report_permission.approved_at <= now())`;
}

function imageUrl(value: unknown, base: string) {
  try { const url = new URL(String(value), base); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

export async function publicNewsImageAllowed(url: string) {
  const [row] = await sql<{ allowed: boolean }[]>`SELECT EXISTS (SELECT 1 FROM publications p
    JOIN sources image_source ON image_source.id = p.source_id
    JOIN studio_public_news permission ON permission.article_id = p.article_id
    WHERE p.visibility <> 'withdrawn' AND ${publicNewsCondition()}
      AND (permission.decision->'images' ? ${url} OR image_source.icon_url = ${url}
        OR (p.visibility = 'public' AND image_source.site_fulltext AND p.body_mode = 'full' AND permission.decision->'fulltextImages' ? ${url}))) AS allowed`;
  return row?.allowed === true;
}

/** A guessed item ID or legacy editorial decision never grants private material public access. */
export function publicNewsCondition(): ReturnType<typeof sql> {
  return sql`EXISTS (SELECT 1 FROM studio_public_news permission
    JOIN studio_history_index h ON h.article_id = permission.article_id
    JOIN articles current_article ON current_article.id = permission.article_id
    JOIN sources current_source ON current_source.id = current_article.source_id
    LEFT JOIN editorial_overrides current_override ON current_override.article_id = permission.article_id
    WHERE permission.article_id = p.article_id AND permission.source_key = h.knowledge->>'sourceKey'
      AND current_article.source_id = p.source_id AND current_source.participation_mode = 'editorial'
      AND current_override.visibility IS DISTINCT FROM 'withdrawn' AND permission.decision->>'allowed' = 'true')`;
}

export async function publicNewsJudgement(db: Db, articleId: string): Promise<PublicationJudgement | null> {
  const [row] = await db<{ decision: PublicationJudgement }[]>`SELECT permission.decision FROM studio_public_news permission
    JOIN studio_history_index h ON h.article_id = permission.article_id
    WHERE permission.article_id = ${articleId} AND permission.source_key = h.knowledge->>'sourceKey'`;
  return row?.decision ?? null;
}

/** Bounded local projection only. It never asks a model to reconsider already-understood facts. */
export async function reconcilePublicNews(now = new Date(), articleIds?:string[]) {
  const cutoff = new Date(now.getTime() - 120 * 3600000);
  const rows = await sql<{ article_id: string }[]>`SELECT h.article_id FROM studio_history_index h
    LEFT JOIN studio_public_news permission ON permission.article_id = h.article_id
    WHERE h.article_id IS NOT NULL AND h.knowledge->>'sourceKey' IS NOT NULL
      AND (${articleIds===undefined} OR h.article_id=ANY(${articleIds??[]}::text[])) AND (h.collected_at >= ${cutoff} OR permission.article_id IS NOT NULL)
    ORDER BY (h.collected_at >= ${cutoff}) DESC, permission.updated_at ASC NULLS FIRST, h.article_id LIMIT 25`;
  let published = 0;
  for (const { article_id: id } of rows) await sql.begin(async db => {
    await db`SELECT id FROM articles WHERE id = ${id} FOR UPDATE`;
    const [record] = await scoringRecords(db, db`h.article_id = ${id}`);
    if (!record?.sourceKey) return;
    const policy = await currentFilterPolicy(db), context = await currentColumnContext(db);
    const events = await sharedEventObservations(db, record.eventId ? [record.eventId] : [], now, policy, "public");
    const score = scoreMaterialV2(record, record.eventId ? events.get(record.eventId) : undefined, now.toISOString(), policy);
    const [source] = await db<{ participation_mode: string; site_fulltext: boolean; url: string; media: Array<{ url?: string; poster?: string }>;
      body_html: string | null; x_post: { avatarUrl?: string; media?: Array<{ url?: string; poster?: string }> } | null }[]>`
      SELECT s.participation_mode, s.site_fulltext, a.url, a.media, a.body_html, a.x_post FROM sources s JOIN articles a ON a.source_id = s.id WHERE a.id = ${id}`;
    const [previous] = await db<{source_key:string;decision:PublicationJudgement;selected_ready_at:Date|null}[]>`
      SELECT permission.source_key,permission.decision,p.selected_ready_at FROM studio_public_news permission
      LEFT JOIN publications p ON p.article_id=permission.article_id WHERE permission.article_id=${id}`;
    // List expiry is not a takedown. Recheck current facts/scope with publication-age freshness;
    // a stale false breakout cannot preserve an old approval through this path.
    const archived = !!record.publishedAt && now.getTime()-record.publishedAt.getTime()>120*3600000
      && previous?.source_key===record.sourceKey && (previous.decision.allowed || !!previous.selected_ready_at)
      && scoreMaterialV2(record,record.eventId ? events.get(record.eventId) : undefined,record.publishedAt.toISOString(),policy).eligiblePublic===true;
    // Qualification is an admission record, not a moving heat ranking. Corrections with a NEW source
    // version still require approval; explicit withdrawals/source isolation remain enforced by publish/read guards.
    const retained = previous?.source_key===record.sourceKey && previous.decision.allowed===true && !record.private
      && source?.participation_mode==='editorial';
    const allowed = retained || (score.eligiblePublic === true || archived) && score.summaryState === "ok" && record.publishedAt !== null && source?.participation_mode === "editorial";
    const images = [...(source?.media ?? []), ...(source?.x_post?.media ?? []), { url: source?.x_post?.avatarUrl }]
      .flatMap(media => [media.url, media.poster]).filter(value => typeof value === "string" && value.trim());
    const fulltextImages: string[] = [];
    if (source?.site_fulltext && source.body_html) {
      const $ = cheerio.load(source.body_html);
      $("img[src], video[poster]").each((_index, element) => { const value = $(element).attr(element.tagName === "video" ? "poster" : "src"); if (value) fulltextImages.push(value); });
    }
    const normalize = (urls: Array<string | undefined>) => [...new Set(urls.flatMap(value => value && source ? imageUrl(value, source.url) ?? [] : []))];
    const ancestors = record.eventId ? await db<{ id: string; parent_id: string | null }[]>`WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, ARRAY[id] AS path FROM studio_shared_events WHERE id = ${record.eventId}
      UNION ALL SELECT parent.id, parent.parent_id, child.path || parent.id FROM studio_shared_events parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE NOT parent.id = ANY(child.path) AND cardinality(child.path) < 30
    ) SELECT id, parent_id FROM ancestors WHERE parent_id IS NULL` : [];
    const rootId = ancestors[0]?.id;
    const publicSummary = publicSummaryState(record.analysis?.shared);
    const reasonLabels: Record<string, string> = { model_release: "正文确认的模型发布", direct_all: "符合AI影视公开范围", direct_selected: "符合AI影视公开与精选资格",
      major_event: "已核实重大事件", verified_breakout: "已确认相关出圈", general_ai_selected: "通用AI达到精选资格",
      market_reference: "非AI影视严格例外", excluded: "未通过公开资格", pending: "待核验", private: "内部材料" };
    const title = record.analysis?.shared?.titleZh ?? (retained?previous!.decision.title:null) ?? await savedNewsTitle(db, record.title) ?? record.title;
    const selected=allowed && (score.eligibleSelected===true || retained && (previous!.decision.selected || !!previous!.selected_ready_at));
    const decision: PublicNewsDecision = { allowed, title, summary: publicSummary.text??(retained?previous!.decision.summary:null),
      reason: retained&&previous!.decision.selected?previous!.decision.reason:[reasonLabels[score.route ?? "pending"] ?? "待核验", ...(score.summaryState === "ok" ? [] : ["摘要待完成"]),
        ...(publicSummary.fallback ? ["摘要使用原文事实回退"] : [])].join("；"),
      category: policy.columnMapping[record.analysis?.columnId ?? ""] ?? null,
      score: retained?previous!.decision.score:score.public.total, selected, images: normalize(images), fulltextImages: normalize(fulltextImages),
      event: allowed && record.eventId && rootId ? { id: record.eventId, rootId, title,
        occurredAt: record.analysis?.shared?.event?.time?.at ?? null } : null };
    await db`INSERT INTO studio_public_news (article_id, source_key, decision, policy_version, semantics_key, updated_at)
      VALUES (${id}, ${record.sourceKey}, ${db.json(decision as never)}, ${policy.version}, ${record.analysis?.columnSemanticsKey ?? context.key}, ${now})
      ON CONFLICT (article_id) DO UPDATE SET source_key = EXCLUDED.source_key, decision = EXCLUDED.decision,
        policy_version = EXCLUDED.policy_version, semantics_key = EXCLUDED.semantics_key, updated_at = EXCLUDED.updated_at`;
    const result = await publishArticleTx(db, id, { now });
    if (result?.changed) await emit("articleChanged", { id, kind: result.changeKind, reduced: result.reduced, reason: "shared publication" }, db);
    if (allowed) published++;
  });
  return { processed: rows.length, published, excluded: rows.length - published };
}
