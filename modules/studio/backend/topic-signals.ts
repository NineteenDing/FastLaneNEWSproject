import { verifiedMemeEvidence } from "./shared-material.ts";
import type { EditorialPolicyV2, EditorialScopeV2, EventPropagationRules, FilterPolicy, SharedTopicSignals, TopicBatchMaterial, TopicMaterialAnalysis } from "../contracts.ts";
import { defaultEventPropagationRules, eventHeat, eventHeatV2, observeEvent, resolveEventTime, type PropagationRow } from "./event-propagation.ts";
import { DEFAULT_EDITORIAL_V2, freshness, routePublic } from "./editorial-v2.ts";
import { heatSnapshot } from "./editorial-v2.ts";
import { platformAttention } from "./platform-attention.ts";

type Material = { material: TopicBatchMaterial; analysis: TopicMaterialAnalysis | null };

const scopeOf = (shared: NonNullable<TopicMaterialAnalysis["shared"]>): EditorialScopeV2 =>
  shared.editorialScope ?? (shared.scope === "direct" ? "direct_ai_film" : shared.scope === "important_ai" ? "general_ai"
    : shared.scope === "unrelated" ? "unrelated" : "uncertain");
const legacyScope = (scope: EditorialScopeV2): SharedTopicSignals["candidates"][number]["scope"] =>
  scope === "direct_ai_film" ? "direct" : scope === "unrelated" ? "unrelated" : scope === "uncertain" ? "uncertain" : "important_ai";
const selectedRoutes = ["direct_selected", "major_event", "verified_breakout", "general_ai_selected", "market_reference"];

/** Uses frozen evidence only: no current database reads, model calls, or mutation of history. */
export function freezeSharedTopicSignals(materials: Material[], asOf: string, propagation: EventPropagationRules = defaultEventPropagationRules,
  heatPolicy?: FilterPolicy["heat"], editorial: EditorialPolicyV2 = DEFAULT_EDITORIAL_V2): SharedTopicSignals | undefined {
  const understood = materials.filter(row => row.analysis?.shared && Date.parse(row.material.collectedAt)<=Date.parse(asOf));
  if (!understood.length) return undefined;
  const cutoff = Date.parse(asOf), rules = { ...propagation, independentReports: editorial.breakout.reports, observedViews: editorial.breakout.views, independentAuthors: editorial.breakout.authors }, start = cutoff - rules.windowHours * 3600000;
  const evidenceAvailable = ({ material, analysis }: Material) => !!analysis?.shared?.facts.length && analysis.gates?.evidence === true
    && ["ok", "collected", "transcribed"].includes(material.bodyState) && !!material.body.trim();
  const idFor = (row: Material) => row.analysis?.sharedEventId ?? "material:" + row.material.id;
  const events: SharedTopicSignals["events"] = [];
  for (const id of new Set(understood.map(idFor))) {
    const related = understood.filter(row => idFor(row) === id);
    const window = related.filter(row => evidenceAvailable(row) && row.material.publishedAt !== null && Date.parse(row.material.collectedAt) <= cutoff
      && Date.parse(row.material.publishedAt) >= start && Date.parse(row.material.publishedAt) <= cutoff);
    const rows: PropagationRow[] = window.map(({ material, analysis }) => {
      const observations = material.observations.filter(observation => Date.parse(observation.observedAt) <= cutoff)
        .slice().sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      const observed = observations.at(-1)?.observedAt ?? (Date.parse(material.collectedAt) <= cutoff ? material.collectedAt : null);
      const metrics = Date.parse(material.updatedAt) <= cutoff ? material.metrics : observations.at(-1)?.metrics;
      return { materialId: material.id, participant: material.source.reporterId ?? (material.source.subject
        ? "creator-subject:" + material.source.subject.id : material.source.platform + ":" + material.source.id),
        reportingKind: analysis!.shared!.reportingKind, scope: analysis!.shared!.scope, platform: material.source.platform,
        kind: material.kind, work: material.source.work?.id ?? material.id, views: metrics?.views ?? null, publishedAt: material.publishedAt!,
        observedAt: observed, hasMemeEvidence: analysis!.shared!.memeEvidence.length > 0, verifiedMeme: verifiedMemeEvidence(analysis!.shared) };
    });
    const qualified = related.some(row => evidenceAvailable(row) && ["direct", "important_ai"].includes(row.analysis!.shared!.scope));
    const baseHeat = eventHeatV2(rows, asOf, editorial);
    const trends=platformAttention(related.flatMap(row=>(row.material.trends??[]).flatMap(trend=> {
      const observation=trend.observations.filter(value=>Date.parse(value.observedAt)<=cutoff).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
      return observation?[{platform:trend.platform,board:trend.platform,rank:observation.rank,observedAt:observation.observedAt,active:trend.active!==false}]:[];
    })),asOf);
    const maximum=(a:number|null,b:number|null)=>a===null?b:b===null?a:Math.max(a,b);
    const heatV2=heatSnapshot({canonicalEventId:id,asOf,observationScope:"internal",state:baseHeat.observed===null&&trends.observed===null?"unknown":"partial",
      observed:maximum(baseHeat.observed,trends.observed),freshObserved:maximum(baseHeat.freshObserved,trends.freshObserved),
      channels:{...baseHeat.channels,trends:trends.channels},missingReasons:baseHeat.missingReasons},editorial);
    const breakout=observeEvent(rows,qualified,asOf,rules,editorial.breakout.freshHours);
    if(qualified&&trends.breakout)breakout.breakout={triggered:true,candidate:true,reasons:[...breakout.breakout.reasons,"independent_platform_trends"]};
    const evidenceTimes=related.filter(evidenceAvailable).map(row=>({reportingKind:row.analysis!.shared!.reportingKind,time:row.analysis!.shared!.event?.time}));
    const resolvedTime=resolveEventTime(evidenceTimes),timeConflict=evidenceTimes.some(row=>!!row.time)&&resolvedTime===null;
    events.push({ id, label: related[0]!.analysis!.shared!.event?.label ?? related[0]!.material.title,
      materialIds: related.map(row => row.material.id), ...breakout,
      time:resolvedTime,timeConflict,
      ...(!resolvedTime&&!timeConflict ? {publicationFallbackAt:related.filter(row=>evidenceAvailable(row)&&row.analysis?.shared?.reportingKind!=="repost"&&row.material.publishedAt)
        .map(row=>row.material.publishedAt!).sort()[0]} : {}),
      ...(heatPolicy ? { heat: eventHeat(rows, asOf, heatPolicy),
        allReposts: related.every(row => row.analysis!.shared!.reportingKind === "repost") } : {}),
      heatObserved: heatV2.observed, heatFresh: heatV2.freshObserved, heatState: heatV2.state, heatDecision: heatV2.decisionValue,
      heatCompensated: heatV2.heatCompensated, interval: [heatV2.lower, heatV2.upper], policyVersion: heatV2.policyVersion });
  }
  const v2 = understood.some(row => !!row.analysis!.shared!.editorialScope && !!row.analysis!.shared!.v2);
  const candidates: SharedTopicSignals["candidates"] = understood.map(row => {
    const shared = row.analysis!.shared!, scope = scopeOf(shared), available = evidenceAvailable(row);
    const event = events.find(candidate => candidate.id === idFor(row))!, heat = event;
    const eventTime = event.time ?? null;
    const published = row.material.publishedAt;
    const age = eventTime ? (cutoff - Date.parse(eventTime.at)) / 3_600_000
      : event.timeConflict || shared.reportingKind === "repost" ? null
      : published ? (cutoff - Date.parse(published)) / 3_600_000 : null;
    const F = freshness(age === null || age < 0 ? null : age, { policy: editorial }).decision;
    const I = shared.v2?.I.value ?? shared.publicDimensions.interest.value ?? null;
    const M = shared.v2?.M.value ?? shared.impact?.value ?? null;
    const D = shared.v2?.D.value ?? shared.publicDimensions.substance.value ?? null;
    const P = shared.v2?.P.value ?? shared.publicDimensions.practical.value ?? null;
    const major = !!shared.majorEvent && shared.majorEvent.kind !== "none" && shared.majorEvent.evidenceFactIds.length > 0;
    const complete = available && I !== null && M !== null && D !== null && P !== null;
    // Internal semantic qualification only; publication permission, publicSummary and page windows are skipped here.
    const route = complete ? routePublic({ dimensions: { I, M, D, P, F }, observed: heat.heatObserved ?? null,
      freshObserved: heat.heatFresh ?? null, state: heat.heatState ?? "unknown", scope, aiCentral: shared.aiCentral,
      filmRelevant: shared.filmRelevant, factsAvailable: available, major, breakout: event.breakout.triggered, policy: editorial }).route : "pending";
    const path = !v2 ? (!available || !["direct", "important_ai"].includes(legacyScope(scope)) ? null
      : event.breakout.triggered ? "breakout" as const : scope === "general_ai" ? "important_ai" as const
      : row.analysis!.gates?.benefit === true ? "direct" as const : null)
      : !selectedRoutes.includes(route) ? route === "direct_all" ? "direct" as const : null
      : route === "major_event" ? "major_event" as const : route === "verified_breakout" ? "breakout" as const
      : route === "general_ai_selected" ? "general_ai" as const : route === "market_reference" ? "market_reference" as const : "direct" as const;
    return { materialId: row.material.id, eventId: event.id, scope: legacyScope(scope), editorialScope: scope, evidenceAvailable: available,
      directBenefit: row.analysis!.gates?.benefit === true, path, route,
      reason: !available ? "完整正文或事实证据不足" : !complete ? "新版语义维度或事实尚不完整，等待重判"
        : route === "excluded" ? "按新版范围与资格门槛排除" : route === "pending" ? "范围或事实待核验"
        : path === "major_event" ? "已核实重大事件，可突破普通总分要求" : path === "breakout" ? "已确认相关出圈，可突破普通总分要求"
        : path === "general_ai" ? "通用AI达到精选级语义资格，不要求教程" : path === "market_reference" ? "非AI影视严格例外"
        : "直接AI影视合格材料，仍需方向级兴趣与证据门槛" };
  });
  return { policy: v2 ? "shared-topic-v2" : "shared-topic-v1", asOf, rules, events, candidates };
}

export const sharedTopicInstructions = "二期共享选题规则：rankingContext.sharedSignals是按本批次截止/捕获时间冻结的传播和候选依据。" +
  "v2中editorialScope区分直接AI影视、通用AI、非AI影视和无关材料；path为major_event/breakout/general_ai/market_reference时已取得事件级资格，" +
  "只有primaryCoreEventId属于major_event或breakout可突破普通方向总分；通用AI精选与market_reference不能借作背景让别的核心事件过线。仍须E≥50、真实核心事实和明确观看收益。" +
  "heatFresh是新鲜实测传播指数，heatState为complete/partial/unknown；unknown只代表观察不足，不是真实零热度，也不是模型判断。" +
  "热度表示已观测传播，不是事实被独立证实，也不保证占每栏前三；不同平台不加总、转载不作多份原始验证。" +
  "新闻和作品不要求操作步骤或两分钟讲完；实操栏目仍须可执行方法。优先综合这些候选，有材料无法成题时保留其归属和理由，不硬凑方向；无关娱乐和事实不足不能借热度放行。";
