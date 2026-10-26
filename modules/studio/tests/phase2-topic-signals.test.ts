import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";
import { topicReviewQueue } from "../backend/topic-review.ts";
import { topicPreviewQueue } from "../backend/topic-preview.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
const body = "2026年10月17日，星幕V2发布角色一致性更新；尚未公布操作教程及收费细节。";
const inputs: Array<{ task?: string; rankingContext?: { sharedSignals?: unknown; filterPolicy?: unknown }; materials?: unknown[] }> = [];
let calls = 0;
let scope: "direct" | "important_ai" = "direct";
let generatedDraft: unknown;
let requireTwoReviews = false;
let materialBenefit = false;
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content); inputs.push(input); calls++;
  let output: unknown;
  if (input.task === "review_packet") output = { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: requireTwoReviews ? [{
    id: "clarity", directionIds: ["v2-impact"], materialIds: [input.materialIds[0]], kind: "promise", severity: "major", problem: "需要明确尚无操作教程", suggestion: "再次说明适用条件待核实",
  }] : [] };
  else if (input.task === "review_summary") output = { passed: !requireTwoReviews, opinionIds: input.opinions.map((opinion: { id: string }) => opinion.id), summary: "事实明确；已观测传播值得解释，尚无教程如实说明" };
  else if (input.task === "revise" || input.task === "adjudicate") output = { recommendation: generatedDraft,
    decisions: input.opinions.map((opinion: { id: string }) => ({ opinionId: opinion.id, decision: "accept", reason: "保留事实与不确定条件" })), summary: "已汇总并采纳两轮的明确条件意见" };
  else if (input.material) output = { columnId: "news", disposition: "support", summary: "星幕V2更新的能力与待明确条件", reason: "制作行业变化，暂无教程",
    viewerBenefit: materialBenefit ? "了解参考限制" : null, event: "星幕V2角色一致性更新", evidenceQuotes: [input.material.body], entities: [],
    gates: { audience: materialBenefit, evidence: true, benefit: materialBenefit }, dimensions: { audience: 30, practical: 5, evidence: 90, freshness: 80, demand: null, distinctiveness: 70 },
    shared: { scope, scopeReason: "涉及影视角色一致性", scopeQuotes: [input.material.body], facts: [{ text: "模型已发布，适配与费用仍需核实", quotes: [input.material.body] }],
      publicDimensions: { practical: { value: 5, reason: "暂无操作教程" }, interest: { value: 80, reason: "创作者讨论" }, substance: { value: 80, reason: "更新事实明确" } },
      impact: { value: 90, reason: "影响创作者后续流程选择" },
      columnMatches: [{ columnId: "news", value: 90, reason: "解释行业变化" }],
      event: { relation: "new", candidateId: null, label: input.material.title, identity: input.material.title + ":" + input.material.body, quotes: [input.material.body],
        time: input.material.body.includes("2026年10月17日") ? { at: "2026-10-17T00:00:00+08:00", precision: "day", quote: "2026年10月17日" } : null },
      reportingKind: "original", memeEvidence: [] } };
  else output = { directions: [{ id: "v2-impact", columnId: "news", eventKey: "v2-update", question: "这次角色一致性更新值得创作者关注吗", viewerBenefit: "分清已公布能力和仍需等待的条件",
    whyNow: "多家来源报道了同一更新", angle: "能力变化和待核实条件", usage: { steps: ["说明更新事实", "列出未公布条件"], conditions: ["等待官方教程与定价"], limitations: ["不宣称已亲测"] },
    titles: ["V2更新，创作者先看这两点", "角色一致性变了什么", "先别急着换流程"], preferredTitle: 0,
    structure: { opening: "先说已经确认的变化", rhythm: "事实后接限制", ending: "等待操作与成本信息" },
    references: [{ materialId: input.materials[0].material.id, role: "fact", quote: input.materials[0].material.body, reason: "已保存的更新报道" }],
    gates: { audience: false, evidence: true, benefit: false }, dimensions: { audience: 30, practical: 5, evidence: 90, freshness: 80, demand: null, distinctiveness: 70, impact: 90 } }],
    assignments: input.materials.map((row: { material: { id: string } }, index: number) => ({ materialId: row.material.id, columnId: "news",
      disposition: index ? "duplicate" : "support", directionIds: index ? [] : ["v2-impact"], reason: index ? "同一更新的传播报道" : "更新事实与条件" })) };
  if (!input.task && input.materials) generatedDraft = output;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

async function run(queue: typeof topicAnalysisQueue | typeof topicGenerationQueue | typeof topicReviewQueue | typeof topicPreviewQueue) {
  const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(queue.name); if (!job) return; await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); }
}

test("出圈传播冻结后进入实际选题与独立二审，来源后改归属不改历史，也不因缺少教程被旧门槛排除", async t => {
  requireTwoReviews = true;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash", apiKey: "private-topic-signals-key",
  } })).statusCode, 200);
  const ids: string[] = [];
  for (let index = 0; index < 10; index++) {
    const sourceId = "topic-signals-" + index;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
      id: sourceId, name: sourceId, kind: "rss", config: { feedUrl: `https://${sourceId}.example/feed` },
    } })).statusCode, 200);
    const saved = await upsertMaterial({ sourceId, title: "星幕V2角色一致性更新", url: `https://${sourceId}.example/update`, via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
    ids.push("news:" + saved.articleId);
  }
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 10); await run(topicAnalysisQueue); assert.equal(calls, 1);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200); await run(topicAnalysisQueue);
  assert.equal(calls, 1);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} })).statusCode, 200);
  const filterPolicy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
    payload: { ...filterPolicy, propagation: { ...filterPolicy.propagation, independentReports: 11 } } })).statusCode, 200);
  // Current identities may change while the durable generation is waiting. Its evidence must stay frozen.
  for (let index = 0; index < 10; index++) {
    const url = "/api/admin/sources/topic-signals-" + index;
    const source = (await app.inject({ url, headers })).json().source;
    assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: source.updated_at, patch: { signal_group_id: "one-agency-after-cutoff" } } })).statusCode, 200);
  }
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${ids[0]}/event`, headers })).json().propagation.independentReporters, 1);
  await run(topicGenerationQueue);
  const initial = (await app.inject({ url: prefix + "/recommendations", headers })).json();
  assert.equal(initial.result.directions[0].score.eligible, true, "有证据的出圈变化不再因缺少实操教程而被旧门槛卡掉");
  assert.equal(initial.result.directions[0].score.total, 54.71, "实际方向使用六维新权重、27小时热度衰减和44小时事件日期，不再用旧的模型时效分");
  assert.equal(initial.result.directions[0].score.configured.contributions.impact, 18);
  const basis = initial.result.sharedSignals;
  assert.deepEqual(initial.result.filterPolicy, filterPolicy, "生成提交时固定完整规则，而不是等待执行时取新规则");
  assert.equal(basis.asOf, "2026-10-18T12:00:00.000Z"); assert.equal(basis.events[0].propagation.independentReporters, 10);
  assert.equal(basis.events[0].breakout.triggered, true); assert.equal(basis.candidates.filter((row: { path: string }) => row.path === "breakout").length, 10);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/review", headers, payload: {} })).statusCode, 200); await run(topicReviewQueue);
  const review = (await app.inject({ url: prefix + "/review", headers })).json(); assert.equal(review.state, "completed");
  assert.equal(review.verdict, "revised"); assert.equal(review.rounds.length, 2); assert.equal(review.decisions.length, 2);
  assert.equal(review.result.directions[0].score.eligible, true); assert.deepEqual(review.result.sharedSignals, basis);
  assert.equal(review.result.directions[0].score.total, 54.71);
  assert.deepEqual(review.result.filterPolicy, filterPolicy);
  assert.deepEqual(inputs.find(input => input.materials)?.rankingContext?.sharedSignals, basis);
  assert.deepEqual(inputs.find(input => input.task === "review_packet")?.rankingContext?.sharedSignals, basis);
  assert.deepEqual(inputs.find(input => input.task === "review_packet")?.rankingContext?.filterPolicy, filterPolicy);
  const before = calls; await app.inject({ url: prefix + "/recommendations", headers }); await app.inject({ url: prefix + "/review", headers }); assert.equal(calls, before);
  requireTwoReviews = false;
});

test("收集中的重要通用AI变化也进入当前栏目选题，不等出圈或先出现操作教程", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T10:00:00Z") }); await resources.warm(); scope = "important_ai";
  try {
    await upsertMaterial({ sourceId: "topic-signals-0", title: "通用模型V3正式发布", url: "https://topic-signals-0.example/v3", via: "import",
      discoveredAt: new Date("2026-10-19T09:00:00Z"), publishedAt: new Date("2026-10-19T08:00:00Z"),
      bodyText: "2026年10月19日，新一代通用模型V3发布，尚未有影视适配记录。", bodyStatus: "ok" });
    await scheduleTopicMaterialAnalyses(); await run(topicAnalysisQueue); const before = calls;
    const url = "/api/admin/studio/topic-batches/current/preview";
    const submitted = await app.inject({ method: "POST", url, headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
    assert.equal(submitted.statusCode, 200, submitted.body); await run(topicPreviewQueue);
    const preview = (await app.inject({ url, headers })).json();
    assert.equal(preview.result.directions[0].score.eligible, true);
    assert.equal(preview.result.sharedSignals.candidates[0].path, "important_ai");
    assert.equal(preview.result.sharedSignals.events[0].breakout.triggered, false);
    assert.equal(preview.result.sharedSignals.rules.independentReports, 11);
    assert.equal(preview.result.filterPolicy.version, 3);
    assert.equal(calls, before + 1, "当前综合复用已完成基础分析，只新增一次综合");
    const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
    const changed = await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers, payload: { ...policy,
      internal: { weights: { ...policy.internal.weights, heat: 35, practical: 5 } } } });
    assert.equal(changed.statusCode, 200, changed.body);
    const updated = (await app.inject({ url, headers })).json();
    assert.equal(updated.result.filterPolicy.version, 4);
    assert.equal(updated.result.directions[0].score.configured.total, 40.21, "现有方向按新权重本地重排，无须重新综合");
    assert.equal(updated.version, preview.version, "仅分数变化不伪造新的正文与引用版本");
    const currentPolicy = changed.json().policy;
    const trial = await app.inject({ method: "POST", url: "/api/admin/studio/filter-settings/preview", headers, payload: { policy: { ...currentPolicy,
      internal: { weights: { ...currentPolicy.internal.weights, heat: 25, practical: 15 } } } } });
    assert.equal(trial.statusCode, 200, trial.body);
    assert.equal(trial.json().directionTotal, 1); assert.equal(trial.json().directions[0].before.score.configured.total, 40.21);
    assert.equal(trial.json().directions[0].after.score.configured.total, 39.29);
    assert.equal(trial.json().directions[0].changed, true);
    t.mock.timers.setTime(new Date("2026-10-20T10:00:00Z").getTime());
    const aged = (await app.inject({ url, headers })).json();
    assert.equal(aged.result.directions[0].score.configured.total, 37.73, "既有方向热度继续按时衰减");
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { startsAt: "2026-10-18T12:00:00Z" } })).json().queued, false);
    assert.equal(calls, before + 1);
  } finally { scope = "direct"; }
});

test("仅有摘要时共享事实仍是待处理材料，不能进入事件传播及出圈候选", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") }); await resources.warm(); scope = "important_ai";
  try {
    const saved = await upsertMaterial({ sourceId: "topic-signals-0", title: "只有摘要的通用模型变化", url: "https://topic-signals-0.example/incomplete", via: "import",
      discoveredAt: new Date("2026-10-19T11:00:00Z"), publishedAt: new Date("2026-10-19T10:00:00Z"), excerpt: "新模型发布，正文还未取得。", bodyStatus: "pending" });
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200, frozen.body);
    const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
    await app.inject({ method: "POST", url, headers, payload: {} }); await run(topicAnalysisQueue);
    const analysis = (await app.inject({ url, headers })).json().rows.find((row: { materialId: string }) => row.materialId === "news:" + saved.articleId);
    assert.equal(analysis.disposition, "pending"); assert.equal(analysis.score.eligible, false);
    const event = (await app.inject({ url: `/api/admin/studio/intelligence/news:${saved.articleId}/event`, headers })).json();
    assert.equal(event.state, "unavailable", "摘要不可被作为已核对的事件传播材料");
  } finally { scope = "direct"; }
});

test("普通方向自身语义拒绝不能被当前数值重排和规则试算撤销", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T10:00:00Z") }); await resources.warm(); materialBenefit = true;
  try {
    await upsertMaterial({ sourceId: "topic-signals-0", title: "单镜头参考限制说明", url: "https://topic-signals-0.example/ordinary-rejected", via: "import",
      discoveredAt: new Date("2026-10-21T09:00:00Z"), publishedAt: new Date("2026-10-21T08:00:00Z"),
      bodyText: "参考能力只支持单人固定机位，不支持多人运动。", bodyStatus: "ok" });
    await scheduleTopicMaterialAnalyses(); await run(topicAnalysisQueue);
    const url = "/api/admin/studio/topic-batches/current/preview", before = calls;
    const submitted = await app.inject({ method: "POST", url, headers, payload: { startsAt: "2026-10-20T12:00:00Z" } });
    assert.equal(submitted.statusCode, 200, submitted.body); await run(topicPreviewQueue);
    const preview = (await app.inject({ url, headers })).json();
    assert.equal(preview.result.sharedSignals.candidates[0].path, "direct");
    assert.equal(preview.result.directions[0].gates.audience, false);
    assert.equal(preview.result.directions[0].gates.benefit, false);
    assert.equal(preview.result.directions[0].score.eligible, false);
    const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
    const trial = await app.inject({ method: "POST", url: "/api/admin/studio/filter-settings/preview", headers, payload: { policy } });
    assert.equal(trial.statusCode, 200, trial.body);
    assert.equal(trial.json().directions[0].after.score.eligible, false);
    assert.equal(calls, before + 1, "读取和试算不追加语义判断");
  } finally { materialBenefit = false; }
});
