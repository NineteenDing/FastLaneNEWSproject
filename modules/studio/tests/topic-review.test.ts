import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, test, type TestContext } from "node:test";
import { config } from "@aihot/backend/config";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit controlled localhost model boundary in this test process.
let stopWorker: (() => Promise<void>) | undefined;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const body = "固定角色参考图，再逐镜生成。官方示例不能当作本人实测。";
let caseNumber = 0;
let reviewMode = "pass";
let omitFinalDecision = false;
afterEach(() => { reviewMode = "pass"; omitFinalDecision = false; });
const provider = await stub((_hit, request) => {
  const payload = JSON.parse(request.body); requests.push(payload);
  const input = JSON.parse(payload.messages.find((message: { role: string }) => message.role === "user").content);
  let result: unknown;
  if (input.task === "review_packet") result = { checkedParts: reviewMode === "missing_part" ? [] : input.parts.map((part: { id: string }) => part.id), opinions: (["two_failures", "unknown_reference", "summary_omission"].includes(reviewMode) || (reviewMode === "second_pass" && input.round === 1)) ? [{
    id: `issue-${input.round}`, directionIds: [reviewMode === "unknown_reference" ? "invented-direction" : "reference"], materialIds: [reviewMode === "unknown_reference" ? "news:99999999" : input.parts[0].materialId], kind: input.round === 1 ? "evidence" : "timing",
    severity: "major", problem: input.round === 1 ? "标题缺少条件" : "步骤过多", suggestion: input.round === 1 ? "明确参考图适用条件" : "缩减演示步骤",
  }] : [] };
  else if (input.task === "review_summary") result = { passed: reviewMode !== "two_failures" && !(reviewMode === "second_pass" && input.round === 1), opinionIds: reviewMode === "summary_omission" ? [] : input.opinions.map((item: { id: string }) => item.id), summary: reviewMode === "two_failures" ? "按意见修订" : "未发现需要修改的问题" };
  else if (input.task === "resolve_opinions") result = { checkedParts: input.parts.map((part: { id: string }) => part.id),
    resolutions: input.opinions.map((item: { id: string }) => ({ opinionId: item.id, decision: "accept", reason: "依据原文保留条件", quotes: [] })) };
  else if (input.task === "revise" || input.task === "adjudicate") {
    const recommendation = structuredClone(input.recommendation);
    // Return only the authorable schema; policy/signals belong to the application's frozen context.
    delete recommendation.filterPolicy; delete recommendation.sharedSignals;
    for (const direction of recommendation.directions) delete direction.score;
    recommendation.directions[0].titles[0] = input.task === "revise" ? "角色参考先讲清条件" : "角色参考的适用条件与两步演示";
    result = { recommendation, decisions: (input.task === "adjudicate" && omitFinalDecision ? [] : input.opinions).map((item: { id: string }, index: number) => ({ opinionId: item.id,
      decision: index ? "partial" : "accept", reason: index ? "保留必要步骤，减少重复演示" : "保留事实限制" })), summary: "补齐条件并压缩演示" };
  }
  else if (input.material) result = { columnId: "practice", disposition: "support", summary: "参考图流程", reason: "有操作条件",
    viewerBenefit: "减少角色漂移", event: "参考图", evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } };
  else {
    const ids = input.materials.map((row: { material: { id: string } }) => row.material.id);
    result = { directions: [{ id: "reference", columnId: "practice", eventKey: "reference", question: "镜头角色变脸怎么办？",
      viewerBenefit: "知道如何固定角色参考", whyNow: "参考流程有更新", angle: "明确操作与限制",
      usage: { steps: ["准备参考图", "逐镜检查"], conditions: ["已有角色图"], limitations: ["仍需实际验证"] },
      titles: ["角色变脸，先检查参考图", "AI漫剧角色参考怎么用", "连续镜头的参考图流程"], preferredTitle: 0,
      structure: { opening: "展示问题", rhythm: "先步骤后限制", ending: "提醒验证" },
      references: ids.map((materialId: string) => ({ materialId, role: "fact", quote: body, reason: "原文步骤" })),
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
    }], assignments: ids.map((materialId: string) => ({ materialId, columnId: "practice", disposition: "support", directionIds: ["reference"], reason: "制作依据" })) };
  }
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "review-test-key", LLM_MODEL: "review-test-model" });
after(async () => { await stopWorker?.(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

async function draft(t: TestContext, content = body) {
  const start = new Date(Date.parse("2026-10-16T12:00:00Z") + caseNumber++ * 48 * 3600_000);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start.getTime() + 48 * 3600_000) });
  await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: `review-source-${caseNumber}`, name: "审核原始来源", kind: "rss", config: { feedUrl: `https://review-${caseNumber}.example/feed` } } })).statusCode, 200);
  await upsertMaterial({ sourceId: `review-source-${caseNumber}`, title: "角色参考流程", url: `https://review-${caseNumber}.example/one`,
    via: "import", discoveredAt: new Date(start.getTime() + 3600_000), publishedAt: start, bodyText: content, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start.toISOString() } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id;
  const prefix = `/api/admin/studio/topic-batches/${batchId}`;
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const boss = await getBoss(), [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} })).statusCode, 200);
  const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation);
  await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
  return prefix;
}

test("初版启动独立全材料审核，第一轮通过即保存最终推荐，刷新和重复提交不重复调用", async t => {
  const prefix = await draft(t), url = prefix + "/review";
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers })).json().state, "not_started");
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.ok(submitted.json().jobId);
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const response = await app.inject({ url, headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const value = response.json(); assert.equal(value.state, "completed"); assert.equal(value.verdict, "passed");
  assert.equal((await app.inject({ url: prefix + "/recommendations", headers })).json().reviewState, "completed");
  assert.equal((await app.inject({ url: prefix, headers })).json().batch.recommendationState, "reviewed");
  assert.equal(value.rounds.length, 1); assert.equal(value.rounds[0].passed, true);
  assert.equal(value.result.directions[0].id, "reference"); assert.equal(value.result.assignments.length, 1);
  const calls = requests.filter(request => JSON.parse(request.messages.at(-1)!.content).task?.startsWith("review_"));
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.messages.length === 2 && call.messages[0]!.role === "system"));
  const packet = JSON.parse(calls[0]!.messages[1]!.content);
  assert.ok(packet.audience.includes("关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验")); assert.equal(packet.columns.length, 5);
  assert.ok(packet.parts.some((part: { content: string }) => part.content.includes(body)));
  const count = requests.length;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  assert.equal((await app.inject({ url, headers })).json().rounds.length, 1); assert.equal(requests.length, count);
});

test("两轮未通过后自动合并全部意见并由模型裁决修订，不要求用户决定，也不发起第三轮", async t => {
  reviewMode = "two_failures";
  const prefix = await draft(t), url = prefix + "/review", firstCall = requests.length;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const value = (await app.inject({ url, headers })).json();
  assert.equal(value.state, "completed"); assert.equal(value.verdict, "revised");
  assert.deepEqual(value.rounds.map((round: { passed: boolean }) => round.passed), [false, false]);
  assert.equal(value.result.directions[0].titles[0], "角色参考的适用条件与两步演示");
  assert.equal(value.summary, "补齐条件并压缩演示");
  assert.equal(value.decisions.length, 2); assert.deepEqual(value.decisions.map((item: { decision: string }) => item.decision), ["accept", "partial"]);
  const inputs = requests.slice(firstCall).map(call => JSON.parse(call.messages.at(-1)!.content));
  assert.deepEqual(inputs.filter(input => input.task === "review_packet").map(input => input.round), [1, 2]);
  const adjudication = inputs.find(input => input.task === "adjudicate");
  assert.deepEqual(new Set(adjudication.opinions.map((item: { id: string }) => item.id)), new Set(value.rounds.flatMap((round: { opinions: Array<{ id: string }> }) => round.opinions.map(item => item.id))));
  assert.equal(inputs.filter(input => input.task === "adjudicate").length, 1);
  assert.ok(requests.slice(firstCall).every(call => call.messages.length === 2), "每次独立对话，不带生成或上一轮的对话历史");
  assert.equal((await app.inject({ url: prefix + "/recommendations", headers })).json().result.directions[0].titles[0], "角色变脸，先检查参考图", "初稿快照不可被最终修订覆盖");
  reviewMode = "pass";
});

test("长正文按编号完整分包审核，每次输入有界且拼回原文一字不缺，不用初筛摘要代替正文", async t => {
  const content = body + "逐镜检查角色、服装和光线，记录每次变化。🎬".repeat(7000) + "材料最后的限制不能丢失。";
  const prefix = await draft(t, content), url = prefix + "/review", firstCall = requests.length;
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const calls = requests.slice(firstCall).filter(call => JSON.parse(call.messages.at(-1)!.content).task === "review_packet");
  assert.ok(calls.length > 1, "超长材料必须分包");
  assert.ok(calls.every(call => call.messages.at(-1)!.content.length <= 48000), "每包实际序列化输入不能超过预算");
  const parts = calls.flatMap(call => JSON.parse(call.messages.at(-1)!.content).parts);
  assert.equal(new Set(parts.map((part: { id: string }) => part.id)).size, parts.length);
  const current = (await app.inject({ url: prefix + "/materials", headers })).json().rows[0];
  const background = (await app.inject({ url: prefix + "/history", headers })).json().items;
  const expected = [{ id: current.id, body: content }, ...background.map((item: { material: { id: string; body: string } }) => item.material)];
  assert.deepEqual(new Set(parts.map((part: { materialId: string }) => part.materialId)), new Set(expected.map(item => item.id)));
  for (const material of expected) assert.equal(JSON.parse(parts.filter((part: { materialId: string }) => part.materialId === material.id)
    .map((part: { content: string }) => part.content).join("")).body, material.body);
  assert.equal((await app.inject({ url, headers })).json().verdict, "passed");
});

test("模型漏掉材料片段的检查回执时整轮失败，不能显示审核通过", async t => {
  reviewMode = "missing_part";
  const prefix = await draft(t), url = prefix + "/review";
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await assert.rejects(topicReviewQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicReviewQueue.name, job.id);
  const value = (await app.inject({ url, headers })).json();
  assert.equal(value.state, "failed"); assert.equal(value.verdict, null); assert.equal(value.result, null);
  reviewMode = "pass";
});

test("审核意见引用不存在的方向或材料时拒绝保存，防止虚构依据进入裁决", async t => {
  reviewMode = "unknown_reference";
  const prefix = await draft(t), url = prefix + "/review";
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await assert.rejects(topicReviewQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicReviewQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "failed");
  reviewMode = "pass";
});

test("本轮汇总不能遗漏已有意见并声称通过，首轮事实问题不能被汇总丢失", async t => {
  reviewMode = "summary_omission";
  const prefix = await draft(t), url = prefix + "/review";
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await assert.rejects(topicReviewQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicReviewQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().verdict, null);
  reviewMode = "pass";
});

test("最终裁决必须逐条交代两轮意见的采纳决定，遗漏时保留失败而非交付最终推荐", async t => {
  reviewMode = "two_failures"; omitFinalDecision = true;
  const prefix = await draft(t), url = prefix + "/review";
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await assert.rejects(topicReviewQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicReviewQueue.name, job.id);
  const value = (await app.inject({ url, headers })).json(); assert.equal(value.state, "failed"); assert.equal(value.result, null);
  reviewMode = "pass"; omitFinalDecision = false;
});

test("中断的审核任务可见失败且必须显式恢复，不能永久显示排队或重复运行活跃任务", async t => {
  const prefix = await draft(t), url = prefix + "/review";
  const response = await app.inject({ method: "POST", url, headers, payload: {} }), id = response.json().jobId;
  assert.ok(id); const boss = await getBoss(); await boss.cancel("studio.topic.review", id);
  assert.equal((await app.inject({ url, headers })).json().state, "failed");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  const retried = await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } });
  assert.equal(retried.json().queued, true); assert.notEqual(retried.json().jobId, id);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queued, false);
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "completed");
});

test("后台自动接续已有初版进入审核，不需用户确认；重复调度不重复入队，模型关闭时等待", async t => {
  const prefix = await draft(t), url = prefix + "/review";
  const { scheduleTopicReviews } = await import("../backend/topic-review.ts");
  config.modelCallsEnabled = false;
  assert.equal((await scheduleTopicReviews()).queued, 0);
  assert.equal((await app.inject({ url, headers })).json().state, "not_started");
  config.modelCallsEnabled = true;
  assert.equal((await scheduleTopicReviews()).queued, 1); assert.equal((await scheduleTopicReviews()).queued, 0);
  const schedule = (await import("../server.ts")).studio.schedules?.find(item => item.name === "studio.topic.review.schedule");
  assert.ok(schedule); assert.equal(schedule.cron, "* * * * *");
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "completed");
});

test("长材料两轮修改和最终裁决也受输入预算约束，裁决按原文分包核对已提出的问题", async t => {
  reviewMode = "two_failures";
  const content = body + "所有生成条件必须核对，不能把宣传当个人实测。".repeat(5000);
  const prefix = await draft(t, content), firstCall = requests.length;
  await app.inject({ method: "POST", url: prefix + "/review", headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const calls = requests.slice(firstCall), inputs = calls.map(call => JSON.parse(call.messages.at(-1)!.content));
  assert.ok(calls.every(call => call.messages.at(-1)!.content.length <= 48000));
  const resolutions = inputs.filter(input => input.task === "resolve_opinions"); assert.ok(resolutions.length > 1);
  assert.ok(resolutions.every(input => input.opinions.length > 0), "只裁决已提出的问题，不启动第三轮开放审核");
  const history = (await app.inject({ url: prefix + "/history", headers })).json(); assert.ok(history.items.length > 0);
  const backgroundIds = history.items.map((item: { material: { id: string } }) => item.material.id);
  for (const input of inputs.filter(input => ["resolve_opinions", "revise", "adjudicate"].includes(input.task)))
    assert.deepEqual(input.backgroundIds, backgroundIds, "长包裁决与最后修订也须保留本期/历史身份");
  const value = (await app.inject({ url: prefix + "/review", headers })).json();
  assert.equal(value.state, "completed"); assert.equal(value.verdict, "revised"); assert.equal(value.rounds.length, 2);
  assert.equal(value.decisions.length, value.rounds.flatMap((round: { opinions: unknown[] }) => round.opinions).length);
  reviewMode = "pass";
});

test("失败后显式重试复用已保存的材料包检查，不重新支付成功步骤或增加逻辑轮次", async t => {
  reviewMode = "summary_omission";
  const prefix = await draft(t), url = prefix + "/review", firstCall = requests.length;
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [first] = await boss.fetch(topicReviewQueue.name); assert.ok(first);
  await assert.rejects(topicReviewQueue.run([first.data] as never[]), /unusable output/); await boss.cancel(topicReviewQueue.name, first.id);
  const savedPackets = requests.slice(firstCall).map(call => JSON.parse(call.messages.at(-1)!.content))
    .filter(input => input.task === "review_packet" && input.round === 1);
  assert.ok(savedPackets.length > 0);
  reviewMode = "two_failures";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queued, true);
  const [second] = await boss.fetch(topicReviewQueue.name); assert.ok(second);
  await topicReviewQueue.run([second.data] as never[]); await boss.complete(topicReviewQueue.name, second.id);
  const inputs = requests.slice(firstCall).map(call => JSON.parse(call.messages.at(-1)!.content));
  assert.deepEqual(inputs.filter(input => input.task === "review_packet" && input.round === 1), savedPackets,
    "新增背景会增加首次材料包，重试仍不能重付任何成功包");
  assert.equal((await app.inject({ url, headers })).json().rounds.length, 2);
  reviewMode = "pass";
});

test("第二轮通过后最终裁决又修改了推荐时，只显示两轮审核并修订，不把未审核的新版本标为通过", async t => {
  reviewMode = "second_pass";
  const prefix = await draft(t), url = prefix + "/review";
  await app.inject({ method: "POST", url, headers, payload: {} });
  const { topicReviewQueue } = await import("../backend/topic-review.ts");
  const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
  await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
  const value = (await app.inject({ url, headers })).json();
  assert.deepEqual(value.rounds.map((round: { passed: boolean }) => round.passed), [false, true]);
  assert.equal(value.result.directions[0].titles[0], "角色参考的适用条件与两步演示");
  assert.equal(value.verdict, "revised");
  assert.equal((await app.inject({ url: prefix, headers })).json().batch.reviewVerdict, "revised");
});

test("无材料的空批次无需付费审核，保存无需审核状态而非假装模型审核通过", async t => {
  const start = new Date(Date.parse("2026-10-16T12:00:00Z") + caseNumber++ * 48 * 3600_000);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start.getTime() + 48 * 3600_000) });
  await resources.warm(); config.modelCallsEnabled = true;
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start.toISOString() } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
  const firstCall = requests.length;
  const submitted = await app.inject({ method: "POST", url: prefix + "/review", headers, payload: {} });
  assert.equal(submitted.json().queued, false);
  const value = (await app.inject({ url: prefix + "/review", headers })).json();
  assert.equal(value.state, "completed"); assert.equal(value.verdict, "no_materials"); assert.equal(value.rounds.length, 0);
  assert.deepEqual(value.result, { directions: [], assignments: [] }); assert.equal(requests.length, firstCall);
});

test("审核实际消费者在模型关闭或5GB低盘时原地等待，6GB恢复后同任务执行且不消耗重试", { timeout: 20_000 }, async t => {
  const prefix = await draft(t), url = prefix + "/review";
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  const id = submitted.json().jobId, firstCall = requests.length; assert.ok(id);
  const { createTopicReviewQueue } = await import("../backend/topic-review.ts");
  const queue = createTopicReviewQueue(resources.host, resources.disk, resources.database), boss = await getBoss();
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  config.modelCallsEnabled = false; stopWorker = await workModuleQueues(boss); await resources.warm();
  await delay(2100); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created"); assert.equal(requests.length, firstCall);
  config.modelCallsEnabled = true; resources.capacity.diskBytes = 5_000_000_000; await resources.disk.sample();
  await delay(2100); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created"); assert.equal(requests.length, firstCall);
  await stopWorker(); resources.capacity.diskBytes = 6_000_000_000;
  stopWorker = await workModuleQueues(boss); await resources.warm();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await boss.findJobs(queue.name, { id }))[0]!.state !== "completed") await delay(30);
  const completed = (await boss.findJobs(queue.name, { id }))[0]!;
  assert.equal(completed.state, "completed"); assert.equal(completed.retryCount, 0);
  const inputs = requests.slice(firstCall).map(call => JSON.parse(call.messages.at(-1)!.content));
  assert.equal(inputs.filter(input => input.task === "review_summary").length, 1);
  const packets = inputs.filter(input => input.task === "review_packet"); assert.ok(packets.length > 0);
  assert.equal(inputs.length, packets.length + 1, "仅首次完整材料包与一次汇总，没有额外重试调用");
  const parts = packets.flatMap(input => input.parts);
  assert.equal(new Set(parts.map((part: { id: string }) => part.id)).size, parts.length);
  for (const id of new Set(parts.map((part: { materialId: string }) => part.materialId))) {
    const materialParts = parts.filter((part: { materialId: string }) => part.materialId === id);
    assert.equal(materialParts.length, materialParts[0].total);
    assert.deepEqual(materialParts.map((part: { part: number }) => part.part), Array.from({ length: materialParts[0].total }, (_, index) => index + 1));
  }
  assert.equal((await app.inject({ url, headers })).json().state, "completed");
  await stopWorker(); stopWorker = undefined;
});
