import assert from "node:assert/strict";
import { test } from "node:test";
import { platformAttention, sameTrendHeadline } from "../backend/platform-attention.ts";

test("两个独立平台同事件可确认出圈，同平台重复榜单和陈旧榜不冒充第二平台", () => {
  const asOf = "2026-10-26T12:00:00Z";
  const row = { platform: "baidu", board: "baidu", rank: 15, observedAt: asOf, active: true };
  assert.equal(platformAttention([row, { ...row, board: "baidu-mirror" }], asOf).breakout, false);
  const two = platformAttention([row, { ...row, platform: "douyin", board: "douyin" }], asOf);
  assert.equal(two.breakout, true);
  assert.ok(two.freshObserved! >= 95);
  assert.equal(platformAttention([row, { ...row, platform: "douyin", observedAt: "2026-10-25T12:00:00Z" }], asOf).breakout, false);
});

test('单一主流热榜前十本身就是相关出圈证据，下榜不抹去曾进前十的资格证据',()=>{
 const at='2026-10-27T12:00:00Z';
 assert.equal(platformAttention([{platform:'zhihu',board:'知乎热榜',rank:8,observedAt:at,active:true}],at).breakout,true);
 assert.equal(platformAttention([{platform:'zhihu',board:'知乎热榜',rank:50,bestRank:8,observedAt:'2026-10-26T12:00:00Z',active:false}],at).breakout,true);
});

test("相关热榜的模型发布问题能关联已有发布报道，但不同版本和网安争议不能串事件",()=>{
 assert.equal(sameTrendHeadline("如何评价 OpenAI 发布的 GPT-6.1 Terra？","OpenAI 发布 GPT-6.1 Terra，主打高效计算机操作与更低成本"),true);
 assert.equal(sameTrendHeadline("如何评价 OpenAI 发布的 GPT-6.1 Terra？","OpenAI 发布 GPT-6.2 Terra"),false);
 assert.equal(sameTrendHeadline("如何看待 Kimi K3.1 Pro 开源版刻意削弱网安能力？","Kimi K3.1 Pro开源版发布"),false);
});

test("单榜条目带10万浏览量级参考，不能写成观测播放量；低排名仍有基础热度",()=>{
 const at="2026-10-27T12:00:00Z";
 const result=platformAttention([{platform:"baidu",board:"baidu",rank:50,observedAt:at,active:true}],at);
 assert.equal(result.channels[0]!.referenceViews,100000);assert.ok(result.observed!>=40);assert.equal(result.breakout,false);
});

test("下榜后保留衰减的历史关注证据，不冒充仍在榜或实时跨平台出圈",()=>{
 const result=platformAttention([{platform:"baidu",board:"baidu",rank:50,observedAt:"2026-10-26T12:00:00Z",active:false}],"2026-10-27T12:00:00Z");
 assert.equal(result.observed,20);assert.equal(result.freshObserved,null);assert.equal(result.breakout,false);
});
