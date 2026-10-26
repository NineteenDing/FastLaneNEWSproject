// Weighted contributions adapt the existing TopicEye port; semantic results stay independent of numeric policy.
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { stableJson } from "@aihot/backend/lib/ids";
import type { DirectionRankingContext, EventTime, FilterMaterialScore, FilterPolicy, FilterPreview, MaterialAnalysisReading, TopicBatchMaterial, TopicDirection, TopicRecommendationResult } from "../contracts.ts";
import { currentFilterPolicy, filterPolicySchema } from "./filter-settings.ts";
import { materialAnalysisJobsAvailable, materialAnalysisReadingsSql } from "./material-analysis-state.ts";
import { currentColumnContext } from "./column-matching.ts";
import { sharedEventObservations, type ObservedSharedEvent } from "./shared-events.ts";
import { rankTopicDirections } from "./topic-ranking.ts";
import { DEFAULT_EDITORIAL_V2, freshness, heatSnapshot, routePublic, scoreInternal } from "./editorial-v2.ts";
import { publicSummaryState } from "./shared-material.ts";

type Analysis = NonNullable<MaterialAnalysisReading["result"]>;
export type ScoringRecord = { materialId: string; title: string; kind: string; publishedAt: Date | null; collectedAt: Date; sourceKey: string;
  private: boolean; complete: boolean; eventId: string | null; analysis: Analysis | null };
const round = (value: number) => Math.round(value * 100) / 100;
const dimensionNames: Record<string, string> = { heat: "传播热度", freshness: "时效变化", impact: "行业影响", practical: "实用价值", evidence: "事实证据", distinctiveness: "差异化" };
const missingDimensions = (values: Record<string, number | null>) => Object.entries(values).filter(([, value]) => value === null).map(([key]) => `缺少${dimensionNames[key] ?? key}的依据`);

export function scoreFreshness(time: EventTime | null | undefined, asOf: string, reportingKind: string | undefined, policy: FilterPolicy): FilterMaterialScore["freshness"] {
  const at = time ? Date.parse(time.at) : NaN, ageHours = (Date.parse(asOf) - at) / 3600000;
  if (!Number.isFinite(at) || ageHours < 0) return { at: null, precision: null, ageHours: null, value: null, basis: "unknown" };
  const value = policy.freshness.bands.find(band => ageHours <= band.hours)?.value
    ?? (reportingKind === "repost" ? policy.freshness.repostValue : policy.freshness.backgroundValue);
  return { at: new Date(at).toISOString(), precision: time!.precision, ageHours: round(ageHours), value, basis: "event_evidence" };
}

function weighted<K extends string>(values: Record<K, number | null>, weights: Record<K, number>) {
  const contributions = Object.fromEntries(Object.entries(weights).map(([key, weight]) => [key, round((values[key as K] ?? 0) * (weight as number) / 100)])) as Record<K, number>;
  return { total: round(Object.values(contributions).reduce<number>((sum, value) => sum + (value as number), 0)), values, contributions };
}

/** Re-score a formed direction, not its highest-scoring news. Semantics and factual references stay intact. */
export function scoreConfiguredDirection(direction: TopicDirection, context: DirectionRankingContext): TopicDirection {
  const policy = context.filterPolicy;
  if (!policy) return direction;
  const facts = new Set(direction.references.filter(ref => ref.role === "fact").map(ref => ref.materialId));
  const cited = (context.sharedSignals?.candidates ?? []).filter(candidate => direction.references.some(ref => ref.role === "fact" && ref.materialId === candidate.materialId));
  const events = (context.sharedSignals?.events ?? []).filter(event => event.materialIds.some(id => facts.has(id)));
  // Frozen results that never carried v2 semantics keep their legacy scoring; they are not relabelled.
  const editorial = context.sharedSignals?.policy === "shared-topic-v2" ? policy.editorial : undefined;
  if (!editorial) {
    const knownHeat = events.flatMap(event => event.heat ? [event.heat.value] : []);
    const freshnessValue = events.map(event => scoreFreshness(event.time, context.asOf, event.allReposts ? "repost" : "original", policy).value).filter(value => value !== null);
    const score = weighted({ heat: knownHeat.length ? Math.max(...knownHeat) : null, freshness: freshnessValue.length ? Math.max(...freshnessValue) : null,
      impact: direction.dimensions.impact ?? null, practical: direction.dimensions.practical, evidence: direction.dimensions.evidence,
      distinctiveness: direction.dimensions.distinctiveness }, policy.internal.weights);
    const gaps = missingDimensions(score.values);
    return { ...direction, score: { ...direction.score, total: score.total, policyVersion: "studio-filter-internal-v1:" + policy.version, gaps,
      configured: { ...score, policyVersion: policy.version, eligible: direction.score.eligible, gaps } } };
  }
  // The primary core event owns the heat; never take the hottest cited background event.
  const primary = events.find(event => event.id === direction.primaryCoreEventId);
  const ageHours = primary?.time ? (Date.parse(context.asOf) - Date.parse(primary.time.at)) / 3_600_000 : null;
  const F = freshness(ageHours === null || ageHours < 0 ? null : ageHours, { policy: editorial }).decision;
  const observed = primary?.heatObserved ?? null, fresh = primary?.heatFresh ?? null, state = primary?.heatState ?? "unknown";
  const score = scoreInternal({ dimensions: { I: direction.dimensions.audience ?? 0, M: direction.dimensions.impact ?? 0,
    E: direction.dimensions.evidence ?? 0, X: direction.dimensions.distinctiveness ?? 0, P: direction.dimensions.practical ?? 0, F },
    observed, freshObserved: fresh, state }, editorial);
  const w = editorial.internal.weights;
  const values = { heat: primary?.heatState === "unknown" ? null : observed, freshness: F, impact: direction.dimensions.impact ?? null,
    practical: direction.dimensions.practical, evidence: direction.dimensions.evidence, distinctiveness: direction.dimensions.distinctiveness };
  const contributions = { heat: round(score.Hdecision * w.heat / 100), freshness: round(F * w.freshness / 100), impact: round((direction.dimensions.impact ?? 0) * w.impact / 100),
    practical: round((direction.dimensions.practical ?? 0) * w.practical / 100), evidence: round((direction.dimensions.evidence ?? 0) * w.evidence / 100),
    distinctiveness: round((direction.dimensions.distinctiveness ?? 0) * w.distinctiveness / 100) };
  const primaryCandidates = cited.filter(candidate => candidate.eventId === primary?.id);
  const special = primaryCandidates.some(candidate => ["breakout", "major_event"].includes(candidate.path ?? ""));
  const relevantCore = !!primary && primaryCandidates.some(candidate => candidate.evidenceAvailable && candidate.path !== null);
  const I = direction.dimensions.audience ?? 0, E = direction.dimensions.evidence ?? 0;
  const eligible = direction.gates.evidence && !!direction.viewerBenefit.trim() && relevantCore && E >= editorial.internal.normal.E
    && (special || (I >= editorial.internal.normal.I && score.S >= editorial.internal.normal.S
      && (!score.heatCompensated || score.B >= editorial.internal.normal.compensatedB)));
  const gaps = [...(!primary ? ["缺少可归属的核心事件"] : []), ...missingDimensions(values), ...(E < 50 ? ["证据支撑未达方向门槛"] : []),
    ...(!special && I < 45 ? ["受众兴趣未达方向门槛"] : [])];
  return { ...direction, primaryCoreEventId: primary?.id ?? direction.primaryCoreEventId,
    score: { ...direction.score, total: score.S, policyVersion: "studio-filter-internal-v2:" + policy.version, eligible, gaps,
      configured: { total: score.S, values, contributions, eligible, gaps, policyVersion: policy.version } } };
}

/** Mutable display only: frozen synthesis, wording and reference version are never overwritten. */
export async function rescoreCurrentDirections(db: Db, result: TopicRecommendationResult, materials: TopicBatchMaterial[], policy: FilterPolicy, now: Date): Promise<TopicRecommendationResult> {
  if (!result.filterPolicy || !result.sharedSignals) return result;
  const ids = result.sharedSignals.events.map(event => event.id).filter(id => z.uuid().safeParse(id).success);
  const observed = await sharedEventObservations(db, ids, now, policy), asOf = now.toISOString();
  const events = result.sharedSignals.events.map(event => {
    const current = observed.get(event.id);
    return current ? { ...event, propagation: current.propagation, breakout: current.breakout, heat: current.heat, time: current.event.time }
      : { ...event, heat: undefined, breakout: { triggered: false, candidate: false, reasons: ["current_observation_unavailable"] } };
  });
  const candidates = result.sharedSignals.candidates.map(candidate => {
    const event = events.find(event => event.id === candidate.eventId);
    const path = !candidate.evidenceAvailable ? null
      : event?.breakout?.triggered && candidate.path !== "market_reference" ? "breakout" as const
      : candidate.path ?? (["direct", "important_ai"].includes(candidate.scope)
        ? event?.breakout?.triggered ? "breakout" as const : candidate.scope === "important_ai" ? "important_ai" as const
          : (candidate.directBenefit ? "direct" as const : null) : null);
    return { ...candidate, path, reason: path === "breakout" ? "当前观察触发出圈规则" : path === "major_event" ? "已核实重大事件"
      : path === "general_ai" ? "通用AI达到精选级语义资格" : path === "market_reference" ? "非AI影视严格例外"
      : path === "important_ai" ? "重要AI变化候选" : path === "direct" ? "直接服务影视创作" : "当前证据或候选条件不足，归档保留" };
  });
  const sharedSignals = { ...result.sharedSignals, asOf, rules: policy.propagation, events, candidates };
  const context: DirectionRankingContext = { policy: "studio-direction-ranking-v2", asOf, filterPolicy: policy, sharedSignals };
  const directions = result.directions.map(direction => {
    const cited = candidates.filter(candidate => direction.references.some(ref => ref.role === "fact" && ref.materialId === candidate.materialId));
    const special = cited.some(candidate => candidate.path === "breakout" || candidate.path === "important_ai");
    const eligible = direction.gates.evidence && !!direction.viewerBenefit.trim() && cited.some(candidate => candidate.path !== null)
      && (special || direction.gates.audience && direction.gates.benefit && (direction.dimensions.audience ?? 0) > 0);
    return scoreConfiguredDirection({ ...direction, score: { ...direction.score, eligible } }, context);
  });
  return { ...result, filterPolicy: policy, sharedSignals, directions: rankTopicDirections(directions, materials, context) };
}

/** Both numerical policies share understanding. No model or current-data access belongs in this function. */
export function scoreMaterial(record: ScoringRecord, event: ObservedSharedEvent | undefined, policy: FilterPolicy, asOf: string): FilterMaterialScore {
  const analysis = record.analysis, shared = analysis?.shared;
  const freshness = scoreFreshness(event ? event.event.time : shared?.event?.time, asOf, shared?.reportingKind, policy);
  const heat = event?.heat ?? null;
  const complete = record.complete && analysis?.gates?.evidence === true && !!shared?.facts.length;
  const relevant = shared?.scope === "direct" || shared?.scope === "important_ai";
  const publicScore = weighted({ practical: shared?.publicDimensions.practical.value ?? null, interest: shared?.publicDimensions.interest.value ?? null,
    heat: heat?.value ?? null, substance: shared?.publicDimensions.substance.value ?? null, freshness: freshness.value }, policy.public.weights);
  const ordinary = publicScore.total > policy.public.selectedAbove && publicScore.contributions.practical >= policy.public.minimumPractical;
  const breakout = !!event?.breakout.triggered && policy.public.allowBreakout;
  const destination = record.private ? "private" : !complete ? "pending" : !relevant ? "excluded" : ordinary || breakout ? "selected_candidate" : "all_candidate";
  const internalScore = weighted({ heat: heat?.value ?? null, freshness: freshness.value, impact: shared?.impact?.value ?? null,
    practical: analysis?.score?.dimensions.practical ?? null, evidence: analysis?.score?.dimensions.evidence ?? null, distinctiveness: analysis?.score?.dimensions.distinctiveness ?? null }, policy.internal.weights);
  const eligible = complete && relevant && (shared?.scope === "important_ai" || event?.breakout.triggered === true || analysis?.gates?.benefit === true);
  return { materialId: record.materialId, policyVersion: policy.version, asOf, eventId: record.eventId, freshness, heat, breakout: event?.breakout ?? null,
    public: { ...publicScore, contributions: { ...publicScore.contributions, impact: 0 },
      destination, reasons: [record.private ? "内部材料不进入公开出口" : !complete ? "共享事实或完整正文尚未准备好" : !relevant ? "不属于AI影视或重要AI变化"
      : ordinary ? "超过普通精选分数与实用门槛" : breakout ? "已确认出圈，走精选例外路径" : "符合公开范围，未达到精选条件"] },
    internal: { ...internalScore, eligible, gaps: missingDimensions(internalScore.values) },
    columnMatches: (shared?.columnMatches ?? []).map(match => ({ ...match, publicColumn: policy.columnMapping[match.columnId] ?? null })) };
}

/** Editorial v2. It requires the v2 shared semantics; an old analysis alone is migration_pending, never a v2 score. */
export function scoreMaterialV2(record: ScoringRecord, event: ObservedSharedEvent | undefined, asOf: string,
  policy?: FilterPolicy): FilterMaterialScore {
  const analysis = record.analysis, shared = analysis?.shared;
  const editorial = policy?.editorial ?? DEFAULT_EDITORIAL_V2;
  // An observed event owns the time: unresolved conflicting originals stay unknown instead of borrowing one report.
  const eventTime = event ? event.event.time : shared?.event?.time ?? null;
  const published = record.publishedAt;
  // A reprint's own timestamp never makes an old event fresh.
  const ageHours = eventTime ? (Date.parse(asOf) - Date.parse(eventTime.at)) / 3_600_000
    : (event?.event.timeConflict || shared?.reportingKind === "repost") ? null
    : published ? (Date.parse(asOf) - published.getTime()) / 3_600_000 : null;
  const f = freshness(ageHours === null || ageHours < 0 ? null : ageHours, { policy: editorial });
  const snap = event?.heatV2 ?? heatSnapshot({ canonicalEventId: record.eventId ?? record.materialId, asOf,
    observationScope: "public", state: "unknown", observed: null, freshObserved: null }, editorial);
  const observed = snap.observed, state = snap.state;
  const I = shared?.v2?.I.value ?? shared?.publicDimensions.interest.value ?? null;
  const M = shared?.v2?.M.value ?? shared?.impact?.value ?? null;
  const D = shared?.v2?.D.value ?? shared?.publicDimensions.substance.value ?? null;
  const P = shared?.v2?.P.value ?? shared?.publicDimensions.practical.value ?? null;
  const E = shared?.v2?.E.value ?? analysis?.score?.dimensions.evidence ?? null;
  const X = shared?.v2?.X.value ?? analysis?.score?.dimensions.distinctiveness ?? null;
  const summary = publicSummaryState(shared);
  const summaryState = summary.text ? "ok" as const : "pending" as const;
  const major = !!shared?.majorEvent && shared.majorEvent.kind !== "none" && shared.majorEvent.evidenceFactIds.length > 0;
  const breakout = event?.breakout?.triggered === true;
  const routeScope = shared?.editorialScope ?? null;
  const factsAvailable = record.complete && !!shared?.facts.length;
  // A v1 "unrelated" verdict stays a terminal exclusion; it is not silently re-labelled as a v2 score.
  const legacyUnrelated = !shared?.editorialScope && shared?.scope === "unrelated";
  const coreMissing = !routeScope || I === null || M === null || D === null || P === null || !factsAvailable;
  const routed = coreMissing ? null : routePublic({
    dimensions: { I, M, D, P, F: f.decision }, observed, freshObserved: snap.freshObserved, state,
    scope: routeScope, aiCentral: shared?.aiCentral, filmRelevant: shared?.filmRelevant,
    factsAvailable, major, breakout, policy: editorial,
  });
  const route = legacyUnrelated ? "excluded" as const : routed?.route ?? "pending" as const;
  const selectedRoute = ["direct_selected", "major_event", "verified_breakout", "general_ai_selected", "market_reference"].includes(route);
  const publicRoute = record.private ? "private" as const : route;
  const destination = record.private ? "private" as const : legacyUnrelated ? "excluded" as const : selectedRoute ? "selected_candidate" as const
    : route === "direct_all" ? "all_candidate" as const : route === "pending" ? "pending" as const : "excluded" as const;
  const pub = routed ?? { base: 0, B: 0, Hdecision: snap.decisionValue, S: 0, heatCompensated: snap.heatCompensated, interval: [0, 0] as [number, number], route, reasonCodes: ["migration_pending"] };
  const internalValues = { heat: observed ?? null, freshness: f.decision, impact: M, practical: P, evidence: E, distinctiveness: X };
  const internalScored = scoreInternal({ dimensions: { I: I ?? 0, M: M ?? 0, E: E ?? 0, X: X ?? 0, P: P ?? 0, F: f.decision },
    observed, freshObserved: snap.freshObserved, state }, editorial);
  const internalEligible = !coreMissing && E !== null && I !== null && (major || breakout
    ? E >= 50 : I >= 45 && E >= 50 && internalScored.S >= 50 && (!internalScored.heatCompensated || internalScored.B >= 60));
  const reasons = legacyUnrelated ? ["legacy_scope_unrelated"] : coreMissing ? ["migration_pending"] : (routed?.reasonCodes ?? []);
  if (summaryState === "pending") reasons.push("public_summary_pending");
  const values = { practical: P, interest: I, heat: observed, substance: D, freshness: f.decision };
  const w = editorial.public.weights, iw = editorial.internal.weights;
  const contributions = { practical: round((P ?? 0) * w.practical / 100), interest: round((I ?? 0) * w.interest / 100),
    impact: round((M ?? 0) * w.impact / 100), heat: round(snap.decisionValue * w.heat / 100), substance: round((D ?? 0) * w.substance / 100),
    freshness: round(f.decision * w.freshness / 100) };
  return {
    materialId: record.materialId, policyVersion: policy?.version ?? 2, asOf, eventId: record.eventId,
    public: { total: pub.S, values, contributions, destination, reasons },
    internal: { total: internalScored.S, values: internalValues, contributions: {
      heat: round(snap.decisionValue * iw.heat / 100), freshness: round(f.decision * iw.freshness / 100), impact: round((M ?? 0) * iw.impact / 100),
      practical: round((P ?? 0) * iw.practical / 100), evidence: round((E ?? 0) * iw.evidence / 100), distinctiveness: round((X ?? 0) * iw.distinctiveness / 100) }, eligible: internalEligible,
      gaps: [...(!coreMissing ? [] : ["migration_pending"]), ...(E === null ? ["缺少证据支撑"] : []), ...(X === null ? ["缺少表达与新增空间"] : [])] },
    freshness: { at: eventTime ? new Date(Date.parse(eventTime.at)).toISOString() : published?.toISOString() ?? null,
      basis: eventTime ? "event_evidence" : "unknown",
      precision: eventTime?.precision ?? null, ageHours, value: f.decision },
    heat: event?.heat ?? null, breakout: event?.breakout ?? null,
    columnMatches: (shared?.columnMatches ?? []).map(match => ({ ...match,
      publicColumn: policy?.columnMapping?.[match.columnId] ?? null })),
    route: publicRoute, eligiblePublic: !record.private && !coreMissing && destination !== "excluded" && destination !== "pending",
    eligibleSelected: !record.private && !coreMissing && selectedRoute, base: pub.base, B: pub.B, interval: pub.interval,
    heatState: state, heatObserved: observed, heatFresh: snap.freshObserved, heatDecision: snap.decisionValue,
    heatCompensated: snap.heatCompensated, summaryState, reasonCodes: reasons,
  };
}

/** Thin metadata projection over source-version-matched existing understanding; never loads full bodies. */
export async function scoringRecords(db: Db, where: ReturnType<Db>): Promise<ScoringRecord[]> {
  const jobs = await materialAnalysisJobsAvailable(db);
  const columns = await currentColumnContext(db);
  return db<ScoringRecord[]>`SELECT h.material_id AS "materialId", h.title, h.kind, h.published_at AS "publishedAt", h.collected_at AS "collectedAt",
    h.knowledge->>'sourceKey' AS "sourceKey", member.event_id AS "eventId", reading.result AS analysis,
    (h.post_id IS NOT NULL OR coalesce(override.visibility = 'withdrawn', false)) AS private,
    CASE WHEN a.id IS NOT NULL THEN a.body_status = 'ok' AND length(coalesce(a.body_text, '')) > 0
      ELSE h.kind <> 'video' OR EXISTS (SELECT 1 FROM studio_media_transcripts t WHERE t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint) END AS complete
    FROM studio_history_index h LEFT JOIN articles a ON a.id = h.article_id LEFT JOIN studio_creator_posts p ON p.id = h.post_id
    LEFT JOIN editorial_overrides override ON override.article_id = a.id
    LEFT JOIN studio_shared_event_members member ON member.material_id = h.material_id AND member.source_key = h.knowledge->>'sourceKey'
    CROSS JOIN LATERAL (SELECT h.material_id) indexed
    LEFT JOIN LATERAL (${materialAnalysisReadingsSql(db, db`h.material_id = indexed.material_id`, jobs, columns)}) reading ON true
    WHERE ${where}`;
}

export async function materialScoring(materialId: string) {
  z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/).parse(materialId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [record] = await scoringRecords(db, db`h.material_id = ${materialId}`);
    if (!record) return null;
    const policy = await currentFilterPolicy(db), asOf = new Date();
    const events = await sharedEventObservations(db, record.eventId ? [record.eventId] : [], asOf, policy);
    return scoreMaterialV2(record, record.eventId ? events.get(record.eventId) : undefined, asOf.toISOString(), policy);
  });
}

/** Prospective numbers only. Source-version understanding is reused and no preview writes a rule or task. */
export async function previewFilterSettings(input: unknown): Promise<FilterPreview> {
  const value = z.object({ policy: filterPolicySchema, page: z.number().int().min(1).max(100000).default(1),
    directionPage: z.number().int().min(1).max(100000).default(1), q: z.string().trim().max(200).default("") }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const current = await currentFilterPolicy(db);
    if (value.policy.version !== current.version) throw new Conflict("筛选规则已变化，请刷新后重新试算");
    const asOf = new Date(), startsAt = new Date(asOf.getTime() - 120 * 3600000);
    const records = await scoringRecords(db, db`coalesce(h.published_at, h.collected_at) >= ${startsAt} AND coalesce(h.published_at, h.collected_at) <= ${asOf}`);
    const ids = [...new Set(records.flatMap(row => row.eventId ? [row.eventId] : []))];
    const beforeEvents = await sharedEventObservations(db, ids, asOf, current), afterEvents = await sharedEventObservations(db, ids, asOf, value.policy);
    const scores = records.map(row => ({ materialId: row.materialId, title: row.title,
      before: scoreMaterialV2(row, row.eventId ? beforeEvents.get(row.eventId) : undefined, asOf.toISOString(), current),
      after: scoreMaterialV2(row, row.eventId ? afterEvents.get(row.eventId) : undefined, asOf.toISOString(), value.policy) }));
    const publicRanks = (which: "before" | "after") => new Map(scores.filter(row => !["private", "excluded", "pending"].includes(row[which].public.destination))
      .sort((a, b) => Number(b[which].public.destination === "selected_candidate") - Number(a[which].public.destination === "selected_candidate")
        || b[which].public.total - a[which].public.total || a.materialId.localeCompare(b.materialId)).map((row, index) => [row.materialId, index + 1]));
    const internalRanks = (which: "before" | "after") => new Map(scores.slice().sort((a, b) => Number(b[which].internal.eligible) - Number(a[which].internal.eligible)
      || b[which].internal.total - a[which].internal.total || a.materialId.localeCompare(b.materialId)).map((row, index) => [row.materialId, index + 1]));
    const beforeRank = publicRanks("before"), afterRank = publicRanks("after"), beforeInternalRank = internalRanks("before"), afterInternalRank = internalRanks("after");
    const rows = scores.map(row => ({ ...row, beforeRank: beforeRank.get(row.materialId) ?? null, afterRank: afterRank.get(row.materialId) ?? null,
      beforeInternalRank: beforeInternalRank.get(row.materialId)!, afterInternalRank: afterInternalRank.get(row.materialId)!,
      changed: stableJson({ public: row.before.public, internal: row.before.internal, columnMatches: row.before.columnMatches })
        !== stableJson({ public: row.after.public, internal: row.after.internal, columnMatches: row.after.columnMatches }) }));
    rows.sort((a, b) => Number(b.changed) - Number(a.changed) || a.afterInternalRank - b.afterInternalRank);
    const visible = rows.filter(row => !value.q || row.title.toLocaleLowerCase().includes(value.q.toLocaleLowerCase()));
    const offset = (value.page - 1) * 10;
    const [saved] = await db<{ result: TopicRecommendationResult; materials: TopicBatchMaterial[] }[]>`SELECT coalesce(result, input->'previous'->'result') AS result,
      CASE WHEN result IS NOT NULL THEN input->'materials' ELSE input->'previous'->'input'->'materials' END AS materials
      FROM studio_topic_previews WHERE starts_at <= ${asOf} AND ends_at > ${asOf} AND (result IS NOT NULL OR input->'previous'->'result' IS NOT NULL)
      ORDER BY starts_at DESC LIMIT 1`;
    const beforeDirections = saved ? (await rescoreCurrentDirections(db, saved.result, saved.materials, current, asOf)).directions : [];
    const afterDirections = saved ? (await rescoreCurrentDirections(db, saved.result, saved.materials, value.policy, asOf)).directions : [];
    const directions: FilterPreview["directions"] = afterDirections.map((after, index) => {
      const before = beforeDirections.find(direction => direction.id === after.id)!;
      return { id: after.id, columnId: after.columnId, title: after.titles[after.preferredTitle] ?? after.question, before, after,
        beforeRank: beforeDirections.indexOf(before) + 1, afterRank: index + 1, changed: before.score.total !== after.score.total || before.score.eligible !== after.score.eligible
          || beforeDirections.indexOf(before) !== index };
    }).filter(row => !value.q || row.title.toLocaleLowerCase().includes(value.q.toLocaleLowerCase()));
    const directionOffset = (value.directionPage - 1) * 6;
    return { policyVersion: current.version, startsAt: startsAt.toISOString(), asOf: asOf.toISOString(), total: visible.length,
      changedCount: visible.filter(row => row.changed).length, page: value.page, hasMore: offset + 10 < visible.length, rows: visible.slice(offset, offset + 10),
      directionTotal: directions.length, directionPage: value.directionPage, directionHasMore: directionOffset + 6 < directions.length, directions: directions.slice(directionOffset, directionOffset + 6) };
  });
}
