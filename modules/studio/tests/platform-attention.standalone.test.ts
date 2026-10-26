import assert from "node:assert/strict";
import { test } from "node:test";
import { platformAttention } from "../backend/platform-attention.ts";

test("两个独立平台同事件可确认出圈，同平台重复榜单和陈旧榜不冒充第二平台", () => {
  const asOf = "2026-10-26T12:00:00Z";
  const row = { platform: "baidu", board: "baidu", rank: 5, observedAt: asOf, active: true };
  assert.equal(platformAttention([row, { ...row, board: "baidu-mirror" }], asOf).breakout, false);
  const two = platformAttention([row, { ...row, platform: "douyin", board: "douyin" }], asOf);
  assert.equal(two.breakout, true);
  assert.ok(two.freshObserved! >= 95);
  assert.equal(platformAttention([row, { ...row, platform: "douyin", observedAt: "2026-10-25T12:00:00Z" }], asOf).breakout, false);
});
