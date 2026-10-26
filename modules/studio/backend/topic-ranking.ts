// Adapted from TopicEye 70e3a86f987e7ab9e4b632c9a4bc63d64f4ad963:
// scoring_engine.py/_compute_time_decay and _compute_diversity_order. Apache-2.0.
// Only freshness contribution decays; small frozen batches use a greedy scan,
// explicit source/event overlap and no category penalty. See vendor/topiceye/NOTICE.md.
import type { DirectionRankingContext, TopicBatchMaterial, TopicDirection } from "../contracts.ts";
import { materialScoringPolicy } from "./topic-scoring.ts";
import { historyTerms } from "./history-index.ts";
export const directionRankingPolicy = { version: "studio-direction-ranking-v2", halfLifeHours: 72, freshnessFloor: .3,
  sourcePenaltyStep: 2, maxSourcePenalty: 4, sameEventAnglePenalty: 4, maxDiversityPenalty: 6,
  scope: "within_column", timeScope: "freshness_contribution_only", unknownDemand: "no_redistribution" } as const;
const round = (value: number) => Math.round(value * 100) / 100;
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const feedbackRankingPolicy = { ...directionRankingPolicy, version: "studio-direction-ranking-v3-feedback", maxPreferenceAdjustment: 3,
  minimumFeedbackSamples: 5, minimumSimilarity: .6, feedbackScope: "explicit_same_column_only" } as const;
const adoptionRankingPolicy = { ...feedbackRankingPolicy, version: "studio-direction-ranking-v4-adoption", adoptedRepeatPenalty: 3,
  adoptedScope: "same_column_exact_event_and_angle_no_new_fact_quote", recentProjectLimit: 20, adoptedContextChars: 6000 } as const;
export const rankingRulesFor = (context: DirectionRankingContext) => {
  const base = context.policy === "studio-direction-ranking-v4-adoption" ? adoptionRankingPolicy
    : context.policy === "studio-direction-ranking-v3-feedback" ? feedbackRankingPolicy : directionRankingPolicy;
  return context.filterPolicy ? { ...base, version: base.version + ":configured-filter", halfLifeHours: context.filterPolicy.heat.halfLifeHours,
    freshnessFloor: 0, timeScope: "configured_event_time_bands", scoring: context.filterPolicy.internal } : base;
};

function preferenceFor(direction: TopicDirection, context: DirectionRankingContext) {
  if (context.policy === "studio-direction-ranking-v2") return null;
  const terms = new Set(historyTerms([direction.question, direction.eventKey, direction.angle].join(" ")).filter(term => term.length > 1));
  const matches = context.feedback.filter(sample => sample.direction.columnId === direction.columnId).map(sample => {
    const exact = normalize(sample.direction.question) === normalize(direction.question) && normalize(sample.direction.angle) === normalize(direction.angle);
    const previous = new Set(historyTerms([sample.direction.question, sample.direction.eventKey, sample.direction.angle].join(" ")).filter(term => term.length > 1));
    const common = [...terms].filter(term => previous.has(term)).length;
    const similarity = exact ? 1 : common >= 2 ? common / new Set([...terms, ...previous]).size : 0;
    return { sample, similarity };
  }).filter(item => item.similarity >= feedbackRankingPolicy.minimumSimilarity);
  // TopicEye clamps a feedback signal then applies its small contribution. Here a
  // five-sample prior and same-column match bound one explicit vote to 0.6 points.
  const signal = matches.reduce((sum, item) => sum + (item.sample.rating === "useful" ? 1 : -1) * item.similarity, 0);
  return { preferenceAdjustment: round(feedbackRankingPolicy.maxPreferenceAdjustment * signal / Math.max(feedbackRankingPolicy.minimumFeedbackSamples, matches.length)), feedbackMatches: matches.length };
}

function adoptionFor(direction: TopicDirection, context: DirectionRankingContext) {
  if (context.policy !== "studio-direction-ranking-v4-adoption") return null;
  const quotes = direction.references.filter(ref => ref.role === "fact").map(ref => normalize(ref.quote));
  const previous = quotes.length ? context.adopted.find(item => item.columnId === direction.columnId && normalize(item.eventKey) === normalize(direction.eventKey)
    && normalize(item.angle) === normalize(direction.angle) && quotes.every(quote => item.quotes.some(old => normalize(old) === quote))) : undefined;
  return { adoptionAdjustment: previous ? -adoptionRankingPolicy.adoptedRepeatPenalty : 0, ...(previous ? { previousProjectId: previous.projectId } : {}) };
}

export function rankTopicDirections(directions: TopicDirection[], materials: TopicBatchMaterial[], context: DirectionRankingContext): TopicDirection[] {
  const cutoff = Date.parse(context.asOf);
  if (!Number.isFinite(cutoff) || ![directionRankingPolicy.version, feedbackRankingPolicy.version, adoptionRankingPolicy.version].includes(context.policy)) throw new Error("选题排序上下文无效，未改变旧结果");
  const prepared = directions.map(direction => {
    const cited = materials.filter(material => direction.references.some(ref => ref.role === "fact" && ref.materialId === material.id));
    const dates = cited.map(material => material.publishedAt ? Date.parse(material.publishedAt) : NaN).filter(time => Number.isFinite(time) && time <= cutoff);
    const freshnessFactor = direction.score.configured ? null : dates.length ? Math.max(directionRankingPolicy.freshnessFloor, Math.exp(-Math.log(2) * (cutoff - Math.max(...dates)) / (directionRankingPolicy.halfLifeHours * 3600000))) : null;
    const timeAdjustment = direction.score.configured ? 0 : round((direction.score.dimensions.freshness ?? 0) * materialScoringPolicy.weights.freshness * ((freshnessFactor ?? 0) - 1));
    const sourceIds = [...new Set(cited.flatMap(material => [material.source.subject ? `person:${material.source.subject.id}` : `${material.source.platform}:${material.source.id}`,
      ...(material.source.work ? [`work:${material.source.work.id}`] : [])]))];
    return { direction, timeAdjustment, freshnessFactor, sourceIds, preference: preferenceFor(direction, context), adoption: adoptionFor(direction, context), event: normalize(direction.eventKey) + "|" + normalize(direction.angle) };
  });
  const groups = new Map<string, typeof prepared>();
  for (const item of prepared) { const group = groups.get(item.direction.columnId) ?? []; group.push(item); groups.set(item.direction.columnId, group); }
  const ranked: TopicDirection[] = [];
  for (const candidates of groups.values()) {
    const sources = new Map<string, number>(), events = new Set<string>();
    while (candidates.length) {
      const choices = candidates.map(item => {
        const overlap = Math.max(0, ...item.sourceIds.map(id => sources.get(id) ?? 0));
        const diversityAdjustment = -Math.min(directionRankingPolicy.maxDiversityPenalty,
          Math.min(directionRankingPolicy.maxSourcePenalty, overlap * directionRankingPolicy.sourcePenaltyStep) + (events.has(item.event) ? directionRankingPolicy.sameEventAnglePenalty : 0));
        const total = round(Math.max(0, Math.min(100, item.direction.score.total + item.timeAdjustment + diversityAdjustment + (item.preference?.preferenceAdjustment ?? 0) + (item.adoption?.adoptionAdjustment ?? 0))));
        return { item, diversityAdjustment, total };
      }).sort((a, b) => Number(b.item.direction.score.eligible) - Number(a.item.direction.score.eligible) || b.total - a.total || a.item.direction.id.localeCompare(b.item.direction.id));
      const selected = choices[0]!, { item } = selected;
      ranked.push({ ...item.direction, score: { ...item.direction.score, total: selected.total,
        ranking: { policy: context.policy, asOf: context.asOf, baseTotal: item.direction.score.total, freshnessFactor: item.freshnessFactor,
          timeAdjustment: item.timeAdjustment, diversityAdjustment: selected.diversityAdjustment, ...(item.preference ?? {}), ...(item.adoption ?? {}) } } });
      candidates.splice(candidates.indexOf(item), 1);
      if (item.direction.score.eligible) { for (const id of item.sourceIds) sources.set(id, (sources.get(id) ?? 0) + 1); events.add(item.event); }
    }
  }
  return ranked.sort((a, b) => Number(b.score.eligible) - Number(a.score.eligible) || b.score.total - a.score.total || a.id.localeCompare(b.id));
}
