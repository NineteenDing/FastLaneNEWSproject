import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EDITORIAL_V2, comparableVolume, freshness, headlineBand, heatForDecision, heatSnapshot,
  interpolate, reporterHeat, routePublic, scorePublic, videoHeat,
} from "../backend/editorial-v2.ts";

const dims = (I: number, M: number, D: number, P: number, F: number) => ({ I, M, D, P, F });

test("设计样例：公开分数与 route 与 v2 方案一致", () => {
  const examples = [
    { id: "weak_financing", scope: "general_ai", d: dims(35, 30, 50, 5, 90), H: null, state: "unknown", expected: "excluded", S: 36.75 },
    { id: "verified_major_open_release", scope: "general_ai", d: dims(80, 95, 85, 20, 100), H: null, state: "unknown", major: true, expected: "major_event", S: 71.5 },
    { id: "viral_ai_entertainment", scope: "direct_ai_film", d: dims(95, 65, 60, 0, 80), H: 90, state: "complete", breakout: true, expected: "verified_breakout", S: 71 },
    { id: "substantial_script_comparison", scope: "direct_ai_film", d: dims(75, 70, 75, 75, 45), H: null, state: "unknown", expected: "direct_selected", S: 65.25 },
    { id: "routine_ai_tool_update", scope: "direct_ai_film", d: dims(55, 50, 60, 50, 80), H: 15, state: "complete", expected: "direct_all", S: 47.25 },
    { id: "thin_ai_promotion", scope: "direct_ai_film", d: dims(60, 30, 20, 20, 100), H: 80, state: "complete", expected: "excluded" },
    { id: "unrelated_viral_gossip", scope: "unrelated", d: dims(95, 30, 70, 0, 100), H: 98, state: "complete", breakout: true, expected: "excluded" },
    { id: "single_source_major_film_change", scope: "direct_ai_film", d: dims(80, 90, 80, 30, 80), H: null, state: "unknown", major: true, expected: "major_event", S: 69.5 },
    { id: "unknown_but_ordinary", scope: "direct_ai_film", d: dims(55, 50, 60, 50, 80), H: null, state: "unknown", expected: "direct_all", S: 52.25 },
    { id: "observed_cold_strong_content", scope: "direct_ai_film", d: dims(80, 80, 80, 80, 80), H: 0, state: "complete", expected: "direct_selected", S: 64 },
    { id: "hot_general_ai_but_not_major", scope: "general_ai", d: dims(85, 80, 75, 15, 90), H: 85, state: "complete", expected: "general_ai_selected", S: 75.5 },
    { id: "non_ai_market_exception", scope: "non_ai_film", d: dims(95, 90, 80, 10, 80), H: 95, state: "complete", breakout: true, expected: "market_reference", S: 82.25 },
    { id: "ordinary_non_ai_film", scope: "non_ai_film", d: dims(60, 40, 60, 10, 90), H: 20, state: "complete", expected: "excluded" },
  ] as const;
  for (const example of examples) {
    const input = { dimensions: example.d, observed: example.H, freshObserved: example.H, state: example.state,
      scope: example.scope, aiCentral: example.scope !== "unrelated" && example.scope !== "non_ai_film",
      filmRelevant: example.scope === "direct_ai_film" || example.scope === "non_ai_film",
      major: "major" in example ? example.major : false, breakout: "breakout" in example ? example.breakout : false } as const;
    const scored = scorePublic(input), routed = routePublic(input);
    assert.equal(routed.route, example.expected, example.id);
    if ("S" in example) assert.equal(scored.S, example.S, example.id);
  }
});

test("热度插值、缺测占位、时效和头条接近带", () => {
  assert.equal(reporterHeat(0), 0);
  assert.equal(reporterHeat(1), 15);
  assert.equal(reporterHeat(3), 40);
  assert.equal(reporterHeat(5), 60);
  assert.equal(reporterHeat(10), 85);
  assert.equal(reporterHeat(20), 95);
  assert.ok(reporterHeat(5.2573) > reporterHeat(5));
  for (const value of [0, 10000, 100000, 500000, 1000000, 5000000]) assert.ok(videoHeat(value) >= 0 && videoHeat(value) <= 100);
  assert.equal(videoHeat(0), 0);
  assert.equal(videoHeat(10000), 10);
  assert.equal(videoHeat(100000), 40);
  assert.equal(videoHeat(500000), 70);
  assert.equal(videoHeat(1000000), 85);
  assert.equal(videoHeat(5000000), 95);
  assert.ok(interpolate(20000000, EDITORIAL_V2.heat.videoAnchors, true) > 95);
  assert.equal(heatForDecision(null, "unknown"), 40);
  assert.equal(heatForDecision(0, "complete"), 0);
  assert.equal(heatForDecision(90, "partial"), 90);
  assert.ok((heatForDecision(10, "partial") - 10) * 0.2 <= 40 * 0.2 + 1e-9);
  assert.equal(freshness(null).decision, 40);
  assert.equal(freshness(0).decision, 100);
  assert.equal(freshness(6).decision, 100);
  assert.equal(freshness(12).decision, 90);
  assert.equal(freshness(24).decision, 80);
  assert.equal(freshness(48).decision, 60);
  assert.equal(freshness(72).decision, 45);
  assert.equal(freshness(120).decision, 25);
  assert.equal(freshness(121).decision, 0);
  assert.equal(freshness(121, { validBackfill: true }).decision, 15);
  assert.ok(headlineBand(90, 87));
  assert.ok(!headlineBand(90, 80));
  assert.ok(headlineBand(40, 37));
  assert.ok(!headlineBand(90, 84.99));
  assert.ok(!comparableVolume(20000000, 5000000));
  assert.ok(comparableVolume(1000000, 800000));
});

test("缺测和区间契约只接受合法组合", () => {
  const complete = heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "complete", observed: 80, freshObserved: 80 });
  assert.equal(complete.decisionValue, 80);
  assert.equal(complete.lower, 80);
  assert.equal(complete.upper, 80);
  assert.equal(complete.heatCompensated, false);
  const partial = heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "partial", observed: 90, freshObserved: 90 });
  assert.equal(partial.decisionValue, 90);
  assert.equal(partial.heatCompensated, false);
  assert.equal(partial.lower, 90);
  assert.equal(partial.upper, 100);
  const unknown = heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "unknown", observed: null, freshObserved: null });
  assert.equal(unknown.decisionValue, 40);
  assert.equal(unknown.lower, 0);
  assert.equal(unknown.upper, 100);
  assert.equal(unknown.heatCompensated, true);
  assert.throws(() => heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "complete", observed: null, freshObserved: null }));
  assert.throws(() => heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "unknown", observed: 50, freshObserved: null }));
  assert.throws(() => heatSnapshot({ canonicalEventId: "e", asOf: new Date().toISOString(), observationScope: "public", state: "partial", observed: 40, freshObserved: 50 }));
});
