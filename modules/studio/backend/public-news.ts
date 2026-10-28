import { savedNewsTitle } from "./news-titles.ts";
import { sql, type Db } from "@aihot/backend/db";
import type { PublicationJudgement } from "@aihot/backend/modules";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { emit, serverModules } from "@aihot/backend/modules";
import { currentFilterPolicy } from "./filter-settings.ts";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { referenceCapacity, retainedReferenceCandidate } from "./reference-quota.ts";
import { editorialEvidenceScope } from "./editorial-evidence.ts";
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
  if (serverModules().find(module => module.publication?.judgement)?.publication?.judgement !== publicNewsJudgement)
    throw new Error("缺少本站公开发布模块，请先installModules(SERVER_MODULES)，禁止回退旧发布流水线");
  const cutoff = new Date(now.getTime() - 120 * 3600000);
  const rows = await sql<{ article_id: string }[]>`SELECT h.article_id FROM studio_history_index h
    LEFT JOIN studio_public_news permission ON permission.article_id = h.article_id
    WHERE h.article_id IS NOT NULL AND h.knowledge->>'sourceKey' IS NOT NULL
      AND (${articleIds===undefined} OR h.article_id=ANY(${articleIds??[]}::text[])) AND (h.collected_at >= ${cutoff} OR permission.article_id IS NOT NULL)
    ORDER BY (h.collected_at >= ${cutoff}) DESC, permission.updated_at ASC NULLS FIRST, h.article_id LIMIT 25`;
  let published = 0;
  for (const { article_id: id } of rows) await sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.public.admissions', 0))`;
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
    const qualificationKey = sha256(stableJson({sourceKey:record.sourceKey,policy:policy.version,scope:record.analysis?.shared?.editorialScope,
      ai:record.analysis?.shared?.aiCentral,film:record.analysis?.shared?.filmRelevant,facts:record.analysis?.shared?.facts,v2:record.analysis?.shared?.v2,
      scopeFactIds:record.analysis?.shared?.scopeFactIds,aiRole:record.analysis?.shared?.aiRole,kind:record.analysis?.shared?.reportingKind}));
    const waitingReference = retainedReferenceCandidate(previous?.decision,qualificationKey) && !record.private && record.complete
      && source?.participation_mode==='editorial' && score.summaryState==='ok';
    let allowed = retained || waitingReference || (score.eligiblePublic === true || archived) && score.summaryState === "ok" && record.publishedAt !== null && source?.participation_mode === "editorial";
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
    const currentScope = record.analysis?.shared ? editorialEvidenceScope(record.analysis.shared).scope : undefined;
    const route = score.route === 'verified_breakout' ? score.route : (retained || waitingReference) && previous!.decision.route ? previous!.decision.route : score.route ?? 'pending';
    const admittedAt = retained ? previous!.decision.admittedAt ?? record.collectedAt.toISOString() : now.toISOString();
    let quotaPending = false;
    if (allowed && route === 'market_reference' && !retained) {
      const groups = await db<{event_key:string;core:boolean}[]>`SELECT coalesce(permission.decision->'event'->>'rootId',permission.article_id) AS event_key,
        bool_or(coalesce(permission.decision->>'route','legacy_core') <> 'market_reference') AS core
        FROM studio_public_news permission JOIN publications p ON p.article_id=permission.article_id
        JOIN studio_history_index h ON h.article_id=permission.article_id JOIN sources s ON s.id=p.source_id
        LEFT JOIN editorial_overrides o ON o.article_id=p.article_id
        WHERE permission.decision->>'allowed'='true' AND permission.source_key=h.knowledge->>'sourceKey'
          AND permission.article_id<>${id} AND p.visibility<>'withdrawn' AND s.participation_mode='editorial' AND o.visibility IS DISTINCT FROM 'withdrawn'
          AND (coalesce((permission.decision->>'admittedAt')::timestamptz,p.discovered_at) AT TIME ZONE 'Asia/Hong_Kong')::date = (${admittedAt}::timestamptz AT TIME ZONE 'Asia/Hong_Kong')::date
        GROUP BY coalesce(permission.decision->'event'->>'rootId',permission.article_id)`;
      const existing = groups.some(group=>group.event_key===(rootId??id));
      quotaPending = !existing && groups.filter(group=>!group.core).length >= referenceCapacity(groups.filter(group=>group.core).length);
      if (quotaPending) allowed=false;
    }
    const publicSummary = publicSummaryState(record.analysis?.shared);
    const title = record.analysis?.shared?.titleZh ?? (retained?previous!.decision.title:null) ?? await savedNewsTitle(db, record.title) ?? record.title;
    const selected=allowed && (score.eligibleSelected===true || retained && (previous!.decision.selected || !!previous!.selected_ready_at));
    const publicLabel = currentScope==='non_ai_film'||currentScope==='adjacent_industry'||route==='market_reference'?'行业参考':currentScope==='general_ai'?'出圈':selected?'精选':null;
    const decision: PublicNewsDecision = { allowed, title, summary: publicSummary.text??(retained?previous!.decision.summary:null),
      reason: allowed ? publicLabel : quotaPending ? '行业参考等待每日额度' : '未通过公开资格', route, qualificationKey,
      ...((allowed || quotaPending) ? {qualifiedAt:(retained || waitingReference) && previous!.decision.qualifiedAt || now.toISOString()} : {}), ...(allowed ? {admittedAt} : {}),
      category: policy.columnMapping[record.analysis?.columnId ?? ""] ?? null,
      score: retained || waitingReference?previous!.decision.score:score.public.total, selected, images: normalize(images), fulltextImages: normalize(fulltextImages),
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
