// Editorial v2 deterministic policy. No database, model, clock or network access belongs here.
import type { EditorialPolicyV2 } from "../contracts.ts";
import { interpolateValue, reporterHeatValue, videoHeatValue } from "@aihot/backend/events/heat-v2";
export type EditorialScope = "direct_ai_film" | "general_ai" | "non_ai_film" | "unrelated" | "uncertain";
export type ObservationState = "complete" | "partial" | "unknown";
export type PublicRoute = "direct_all" | "direct_selected" | "major_event" | "verified_breakout" | "general_ai_selected" | "market_reference" | "excluded" | "pending" | "private";
export type Dimensions = { I: number; M: number; D: number; P: number; F: number };
export type InternalDimensions = { I: number; M: number; E: number; X: number; P: number; F: number };

export const DEFAULT_EDITORIAL_V2: EditorialPolicyV2 = {
  schemaVersion: 2,
  policyVersion: "editorial-v2.1-20261026",
  public: {
    weights: { interest: 25, impact: 25, substance: 15, practical: 10, freshness: 5, heat: 20 },
    all: { S: 45, B: 40, I: 35, D: 40, compensatedB: 50 },
    selected: { S: 55, B: 60, I: 60, D: 50, compensatedB: 65 },
    general: { S: 70, M: 75, I: 65, D: 55, compensatedB: 75 },
    nonAi: { M: 80, I: 80, D: 55, S: 75 },
    major: { M: 85, I: 60, D: 55 },
  },
  internal: {
    weights: { heat: 20, interest: 25, impact: 20, evidence: 15, distinctiveness: 10, practical: 5, freshness: 5 },
    normal: { I: 45, E: 50, S: 50, compensatedB: 60 },
  },
  heat: {
    halfLifeHours: 24,
    decisionPlaceholder: 40,
    reporterAnchors: [[0, 0], [1, 15], [3, 40], [5, 60], [10, 85], [20, 95]] as Array<[number, number]>,
    videoAnchors: [[0, 0], [10000, 10], [100000, 40], [500000, 70], [1000000, 85], [5000000, 95]] as Array<[number, number]>,
  },
  freshness: {
    anchors: [[0, 100], [6, 100], [12, 90], [24, 80], [48, 60], [72, 45], [120, 25]] as Array<[number, number]>,
    validBackfillValue: 15,
    unknownDecision: 40,
  },
  windows: { allHours: 120, selectedHours: 48, hotHours: 48, dailyHours: 24, lateHours: 168, policyHours: 720 },
  breakout: { reports: 10, views: 1000000, authors: 3, freshHours: 6 },
  daily: { headlineBandMax: 5, headlineBandRatio: 0.10, volumeRatio: 0.8, emergencyHeat: 70 },
};
/** Frozen built-in baseline; saved policy versions may carry an edited copy of the same shape. */
export const EDITORIAL_V2 = DEFAULT_EDITORIAL_V2;

export interface HeatSnapshotV2 {
  canonicalEventId: string;
  asOf: string;
  observationScope: "public" | "internal";
  expectedScopeVersion: string;
  state: ObservationState;
  observed: number | null;
  freshObserved: number | null;
  decisionValue: number;
  heatCompensated: boolean;
  lower: number;
  upper: number;
  channels: {
    reports: { value: number | null; participants: number; effective: number; freshValue: number | null; freshParticipants: number; freshEffective: number };
    video: Array<{ platform: string; value: number | null; effective: number; freshValue: number | null; freshEffective: number; works: number; authors: number; freshAuthors: number }>;
    trends: Array<{ board: string; value: number | null; freshValue: number | null; rank?: number }>;
  };
  missingReasons: string[];
  memberVersion: string;
  policyVersion: string;
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

export const interpolate = interpolateValue;
export const reporterHeat = reporterHeatValue;
export const videoHeat = videoHeatValue;

export function freshness(ageHours: number | null, options: { validBackfill?: boolean; policy?: EditorialPolicyV2 } = {}): { decision: number; lower: number; upper: number; known: boolean } {
  const config = options.policy ?? EDITORIAL_V2;
  if (ageHours === null || !Number.isFinite(ageHours) || ageHours < 0) {
    return { decision: config.freshness.unknownDecision, lower: 0, upper: 100, known: false };
  }
  if (ageHours === 0) {
    const value = config.freshness.anchors[0]![1];
    return { decision: value, lower: value, upper: value, known: true };
  }
  if (ageHours <= 120) {
    const value = interpolate(Math.max(0, ageHours), config.freshness.anchors);
    return { decision: value, lower: value, upper: value, known: true };
  }
  const value = options.validBackfill ? config.freshness.validBackfillValue : 0;
  return { decision: value, lower: value, upper: value, known: true };
}

const normalizedWeights = <T extends Record<string, number>>(weights: T) =>
  Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / 100])) as Record<keyof T, number>;

export function heatForDecision(observed: number | null, state: ObservationState, policy = EDITORIAL_V2): number {
  if (state === "complete") return observed ?? 0;
  if (state === "unknown") return policy.heat.decisionPlaceholder;
  return Math.max(observed ?? 0, policy.heat.decisionPlaceholder);
}

export function scorePublic(input: { dimensions: Dimensions; observed: number | null; freshObserved: number | null; state: ObservationState }, policy: EditorialPolicyV2 = EDITORIAL_V2) {
  const w = normalizedWeights(policy.public.weights);
  const base = w.interest * input.dimensions.I + w.impact * input.dimensions.M + w.substance * input.dimensions.D
    + w.practical * input.dimensions.P + w.freshness * input.dimensions.F;
  const decision = heatForDecision(input.observed, input.state, policy);
  const lowerHeat = input.state === "complete" ? (input.observed ?? 0) : (input.freshObserved ?? 0);
  const upperHeat = input.state === "complete" ? (input.observed ?? 0) : 100;
  return {
    base, B: base / (1 - w.heat), Hdecision: decision, S: base + w.heat * decision,
    heatCompensated: input.observed === null || decision > input.observed,
    interval: [round2(base + w.heat * lowerHeat), round2(base + w.heat * upperHeat)] as [number, number],
  };
}

export function scoreInternal(input: { dimensions: InternalDimensions; observed: number | null; freshObserved: number | null; state: ObservationState }, policy: EditorialPolicyV2 = EDITORIAL_V2) {
  const w = normalizedWeights(policy.internal.weights);
  const base = w.interest * input.dimensions.I + w.impact * input.dimensions.M + w.evidence * input.dimensions.E
    + w.distinctiveness * input.dimensions.X + w.practical * input.dimensions.P + w.freshness * input.dimensions.F;
  const decision = heatForDecision(input.observed, input.state, policy);
  const lowerHeat = input.state === "complete" ? (input.observed ?? 0) : (input.freshObserved ?? 0);
  const upperHeat = input.state === "complete" ? (input.observed ?? 0) : 100;
  return {
    base, B: base / (1 - w.heat), Hdecision: decision, S: base + w.heat * decision,
    heatCompensated: input.observed === null || decision > input.observed,
    interval: [round2(base + w.heat * lowerHeat), round2(base + w.heat * upperHeat)] as [number, number],
  };
}

export interface PublicRouteInput {
  dimensions: Dimensions;
  observed: number | null;
  freshObserved: number | null;
  state: ObservationState;
  scope: EditorialScope;
  aiCentral?: boolean;
  filmRelevant?: boolean;
  factsAvailable?: boolean;
  major?: boolean;
  breakout?: boolean;
  policy?: EditorialPolicyV2;
}

export function routePublic(input: PublicRouteInput): ReturnType<typeof scorePublic> & { route: PublicRoute; reasonCodes: string[] } {
  const policy = input.policy ?? EDITORIAL_V2;
  const scored = scorePublic(input, policy);
  const reasonCodes: string[] = [];
  if (input.scope === "uncertain") return { ...scored, route: "pending", reasonCodes: ["scope_uncertain"] };
  if (input.scope === "unrelated") return { ...scored, route: "excluded", reasonCodes: ["scope_unrelated"] };
  const scopeMatch = input.scope === "direct_ai_film" ? input.aiCentral === true && input.filmRelevant === true
    : input.scope === "non_ai_film" ? input.filmRelevant === true : input.aiCentral === true;
  if (!scopeMatch) return { ...scored, route: "excluded", reasonCodes: ["scope_evidence_mismatch"] };
  if (input.factsAvailable === false) return { ...scored, route: "excluded", reasonCodes: ["facts_unavailable"] };
  const major = input.major === true && input.dimensions.M >= policy.public.major.M && input.dimensions.I >= policy.public.major.I
    && input.dimensions.D >= policy.public.major.D && (input.scope === "direct_ai_film" || input.scope === "general_ai");
  const breakout = input.breakout === true && input.dimensions.D >= 40;
  if (input.scope === "non_ai_film") {
    const selected = breakout && input.dimensions.M >= policy.public.nonAi.M && input.dimensions.I >= policy.public.nonAi.I
      && input.dimensions.D >= policy.public.nonAi.D && scored.S >= policy.public.nonAi.S;
    return { ...scored, route: selected ? "market_reference" : "excluded", reasonCodes: selected ? ["non_ai_exception"] : ["non_ai_not_qualified"] };
  }
  if (major || breakout) return { ...scored, route: major ? "major_event" : "verified_breakout",
    reasonCodes: major ? ["verified_major_event"] : ["verified_breakout"] };
  if (input.scope === "general_ai") {
    const selected = scored.S >= policy.public.general.S && input.dimensions.M >= policy.public.general.M
      && input.dimensions.I >= policy.public.general.I && input.dimensions.D >= policy.public.general.D
      && (!scored.heatCompensated || scored.B >= policy.public.general.compensatedB);
    return { ...scored, route: selected ? "general_ai_selected" : "excluded", reasonCodes: selected ? ["general_ai_selected"] : ["general_ai_not_qualified"] };
  }
  const ordinary = scored.S >= policy.public.selected.S && scored.B >= policy.public.selected.B
    && input.dimensions.I >= policy.public.selected.I && input.dimensions.D >= policy.public.selected.D
    && (!scored.heatCompensated || scored.B >= policy.public.selected.compensatedB);
  if (ordinary) return { ...scored, route: "direct_selected", reasonCodes: ["direct_selected"] };
  const all = scored.S >= policy.public.all.S && scored.B >= policy.public.all.B && input.dimensions.I >= policy.public.all.I
    && input.dimensions.D >= policy.public.all.D && (!scored.heatCompensated || scored.B >= policy.public.all.compensatedB);
  return { ...scored, route: all ? "direct_all" : "excluded", reasonCodes: all ? ["direct_all"] : ["direct_not_qualified"] };
}

export function headlineBand(top: number, candidate: number, policy: EditorialPolicyV2 = EDITORIAL_V2): boolean {
  const epsilon = Math.min(policy.daily.headlineBandMax, policy.daily.headlineBandRatio * top, 100 - top);
  return top - candidate <= epsilon + 1e-9;
}

export function comparableVolume(top: number, candidate: number, policy: EditorialPolicyV2 = EDITORIAL_V2): boolean {
  return top > 0 && candidate >= top * policy.daily.volumeRatio;
}

export function comparableRank(top:number,candidate:number) {
  return Number.isInteger(top)&&top>=1&&Number.isInteger(candidate)&&candidate>=1&&Math.abs(top-candidate)<=2;
}

export function heatSnapshot(input: {
  canonicalEventId: string;
  asOf: string;
  observationScope: "public" | "internal";
  state: ObservationState;
  observed: number | null;
  freshObserved: number | null;
  missingReasons?: string[];
  memberVersion?: string;
  channels?: HeatSnapshotV2["channels"];
}, policy: EditorialPolicyV2 = EDITORIAL_V2): HeatSnapshotV2 {
  const state = input.state;
  const observed = state === "unknown" ? null : input.observed;
  const fresh = observed === null ? null : input.freshObserved;
  const decisionValue = heatForDecision(observed, state, policy);
  const lower = state === "complete" ? (observed ?? 0) : state === "unknown" ? 0 : (fresh ?? 0);
  const upper = state === "complete" ? (observed ?? 0) : 100;
  if (observed !== null && (!Number.isFinite(observed) || observed < 0 || observed > 100)) throw new Error("H_observed out of range");
  if (fresh !== null && (!Number.isFinite(fresh) || fresh < 0 || fresh > 100 || (observed !== null && fresh > observed))) throw new Error("H_fresh out of range");
  if (state === "complete" && observed === null) throw new Error("complete heat needs observed");
  if (state === "unknown" && input.observed !== null) throw new Error("unknown heat cannot carry observed");
  return {
    canonicalEventId: input.canonicalEventId, asOf: input.asOf, observationScope: input.observationScope,
    expectedScopeVersion: input.observationScope, state, observed, freshObserved: fresh, decisionValue,
    heatCompensated: observed === null || decisionValue > observed, lower, upper,
    channels: input.channels ?? { reports: { value: observed, participants: 0, effective: 0, freshValue: fresh, freshParticipants: 0, freshEffective: 0 }, video: [], trends: [] },
    missingReasons: input.missingReasons ?? [], memberVersion: input.memberVersion ?? "", policyVersion: policy.policyVersion,
  };
}
