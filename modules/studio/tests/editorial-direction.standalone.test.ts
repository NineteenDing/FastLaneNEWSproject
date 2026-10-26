import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreConfiguredDirection } from "../backend/filter-scoring.ts";
import { DEFAULT_EDITORIAL_V2 } from "../backend/editorial-v2.ts";
import type { DirectionRankingContext, TopicDirection } from "../contracts.ts";

test("非核心的通用AI精选事实不能给不合格方向借例外资格", () => {
  const asOf = "2026-10-26T00:00:00Z";
  const direction = { primaryCoreEventId: "cold", references: [{ role: "fact", materialId: "a" }, { role: "fact", materialId: "b" }],
    dimensions: { audience: 0, impact: 0, evidence: 50, distinctiveness: 0, practical: 0 }, gates: { evidence: true },
    viewerBenefit: "了解某条消息", score: { eligible: false, total: 0 } } as TopicDirection;
  const context = { filterPolicy: { version: 2, editorial: DEFAULT_EDITORIAL_V2 }, asOf, sharedSignals: {
    policy: "shared-topic-v2", candidates: [{ materialId: "a", eventId: "cold", evidenceAvailable: true, path: "direct" },
      { materialId: "b", eventId: "other", evidenceAvailable: true, path: "general_ai" }],
    events: [{ id: "cold", materialIds: ["a"], time: { at: asOf }, heatObserved: 0, heatFresh: 0, heatState: "complete" }] } } as DirectionRankingContext;
  assert.equal(scoreConfiguredDirection(direction, context).score.eligible, false);
});
