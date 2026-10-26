// Adapted from TopicEye scoring_engine.py/_compute_base_score and scoring_caliber.py,
// commit 70e3a86f987e7ab9e4b632c9a4bc63d64f4ad963. Copyright 2026 fxbin.
// Apache-2.0; see ../vendor/topiceye/LICENSE and NOTICE.md for changes.
import type { MaterialDimensions, TopicBatchMaterial } from "../contracts.ts";
export const materialScoringPolicy = {
  version: "studio-material-v1",
  weights: { audience: .25, practical: .25, evidence: .2, freshness: .1, demand: .1, distinctiveness: .1 },
};
type Dimension = keyof typeof materialScoringPolicy.weights;

/** Same evidence threshold at material and direction level; callers choose the cited scope. */
export function hasComparableDemandSignal(material: Pick<TopicBatchMaterial, "comments" | "observations">) {
  return material.comments.some(comment => comment.text.trim())
    || new Set(material.observations.filter(item => item.metrics.views !== null).map(item => item.observedAt)).size >= 2;
}

/** Unknown values stay null. Their unearned contribution is never redistributed. */
export function initialMaterialScore(dimensions: MaterialDimensions, gates: { audience: boolean; evidence: boolean; benefit: boolean }) {
  const contributions = Object.fromEntries(Object.entries(materialScoringPolicy.weights)
    .map(([key, weight]) => [key, (dimensions[key as Dimension] ?? 0) * weight]));
  return { policyVersion: materialScoringPolicy.version, dimensions, contributions,
    total: Math.round(Object.values(contributions).reduce((sum, value) => sum + value, 0) * 100) / 100,
    eligible: gates.audience && gates.evidence && gates.benefit,
    gaps: dimensions.demand === null ? ["缺少可比较的关注需求信号"] : [] };
}
