// Public scope at read time. Every query that decides whether a report is public now,
// listed, selected, or evidence of its fact uses these predicates over `publications p` (and, for
// evidence, `fact_articles fa`); no other module spells visibility, the release time or the composite
// rule in SQL, and grouping takes the composite rule from here too. What a publication holds is
// derived once, at publish time, by publish.ts and rules.ts.
import { sql } from "../db.ts";
import { independentSelectedSources } from './rules.ts';
import { serverModules } from '../modules.ts';
import { beijingMidnight, isValidDate } from "@aihot/contracts/time";

/** Site-owned permission is enforced at every read, including stable links and old sync payloads. */
export function readableCondition() {
  return serverModules().reduce((condition, module) => module.publication ? sql`${condition} AND (${module.publication.condition()})` : condition, sql`true`);
}

/** Report prose has its own approval; permitted citations cannot authorize a whole saved issue. */
export function reportReadableCondition(alias = "r") {
  return serverModules().reduce((condition, module) => module.publication?.reportCondition
    ? sql`${condition} AND (${module.publication.reportCondition(alias)})` : condition, sql`true`);
}

export function publicationNeedsRevalidation() {
  return serverModules().some(module => module.publication?.revalidate === true);
}

export function hasPreparedPublication() {
  return serverModules().some(module => !!module.publication?.judgement);
}

/** Browsing age is independent from permission to read an archived item or cite it in a saved issue. */
export function browseWindowCondition(now: Date) {
  const windows = serverModules().flatMap(module => module.publication?.browseWindowHours ? [module.publication.browseWindowHours] : []);
  if (!windows.length) return sql`true`;
  const start = new Date(now.getTime() - Math.min(...windows) * 3600000);
  return sql`coalesce(p.published_at, p.discovered_at) >= ${start} AND coalesce(p.published_at, p.discovered_at) <= ${now}
    AND p.sort_at >= ${start} AND p.sort_at <= ${now}`;
}

/** Admission remains permanent; the selected list browses five days, independently of heat decay. */
export function selectedWindowCondition(now: Date, hours = 120) {
  const start = new Date(now.getTime() - hours * 3600000);
  return sql`coalesce(p.published_at, p.discovered_at) >= ${start} AND coalesce(p.published_at, p.discovered_at) <= ${now}
    AND p.sort_at >= ${start} AND p.sort_at <= ${now}`;
}

export function browseDayCondition(day: string | null | undefined, time = sql`p.timeline_at`) {
  if (!day) return sql`true`;
  if (!isValidDate(day)) return sql`false`;
  const start = beijingMidnight(day);
  return sql`${time} >= ${start} AND ${time} < ${new Date(start.getTime() + 86400000)}`;
}

export function reportKindEnabled(kind: "daily" | "weekly" | "monthly") {
  return serverModules().every(module => !module.publication?.reportKinds || module.publication.reportKinds.includes(kind));
}

/** These reports share their fact's display slot; independent sources keep their own selected card. */
export function foldableSelectionCondition() {
  return sql`(NOT p.selected OR p.source_id <> ALL(${independentSelectedSources()}::text[]))`;
}

export function readingGroupKey() {
  return sql`CASE WHEN p.fact_id IS NOT NULL AND ${ownFactEvidenceCondition()} AND ${foldableSelectionCondition()}
    THEN 'f' || p.fact_id::text ELSE 'a' || p.article_id END`;
}

/**
 * Only confirmed news enters p.selected (publish.ts). The release timestamp also supports
 * historical imports and ensures every outlet uses the same actual publication time.
 */
export function releasedCondition(now: Date) {
  return sql`(NOT p.selected OR p.visible_after <= ${now})`;
}

/** Listed on public surfaces at `now`: public, pool eligible, and released by then. */
export function listedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)} AND ${readableCondition()}`;
}

/** Story reports include older editorial material outside the pool, but never withdrawn or not yet released content. */
export function storyReportCondition(now: Date) {
  return sql`p.visibility = 'public' AND s.participation_mode = 'editorial' AND ${releasedCondition(now)} AND ${readableCondition()}`;
}

/** Selected set as the website shows it (home timeline, reading groups, topics): every selected report. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND ${readableCondition()}`;
}

/**
 * The selected set as machines receive it (v1, RSS, the sync ledger): the representative of ordinary
 * reports of each fact, plus any independently displayed selected articles (publish.ts settleSeats).
 */
export function seatedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.seat AND p.visible_after <= ${now} AND ${readableCondition()}`;
}

/** The report was published from a composite (multi-topic) analysis: it only mentions facts. */
export function compositeCondition() {
  return sql`EXISTS (SELECT 1 FROM analyses evidence_an WHERE evidence_an.id = p.analysis_id AND evidence_an.output->>'scope' = 'composite')`;
}

/**
 * The same rule over the latest analysis of report `article`, for grouping (recall, story roots,
 * consolidation) and for publish.ts when it picks a publication's fact. They decide from the newest
 * analysis, which `p.analysis_id` only points to once the publication is rebuilt from it, and recall
 * also meets reports without a publication. Missing scope is unknown, never composite.
 */
export function latestCompositeCondition(article: ReturnType<typeof sql>) {
  return sql`(SELECT scope_analysis.output->>'scope' = 'composite' FROM analyses scope_analysis
    WHERE scope_analysis.article_id = ${article}
    ORDER BY scope_analysis.input_revision DESC, scope_analysis.id DESC LIMIT 1) IS TRUE`;
}

/** `fa` links report `p` to a fact as evidence: a primary or report membership, never a composite. */
export function evidenceCondition() {
  return sql`fa.role <> 'mention' AND NOT ${compositeCondition()}`;
}

/**
 * Report `p` is still evidence of its own fact (`publications.fact_id`, written at publish time): a
 * membership removed or turned into a mention since then no longer counts.
 */
export function ownFactEvidenceCondition() {
  return sql`EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id = p.fact_id AND fa.article_id = p.article_id AND ${evidenceCondition()})`;
}
