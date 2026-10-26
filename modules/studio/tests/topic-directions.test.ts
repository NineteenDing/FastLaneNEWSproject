import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
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
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit controlled localhost model boundary in this test process.
let stopWorker: (() => Promise<void>) | undefined;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let mode = "valid", caseNumber = 0;
const provider = await stub((_hit, request) => {
  const payload = JSON.parse(request.body); requests.push(payload);
  const input = JSON.parse(payload.messages.find((message: { role: string }) => message.role === "user").content);
  if (input.material) return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "角色参考流程", reason: "有制作步骤",
    viewerBenefit: "减少角色漂移", event: "角色参考", evidenceQuotes: ["先固定参考图，再生成镜头。"], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
  }) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
  const ids = input.materials.map((item: { material: { id: string } }) => item.material.id);
  return { choices: [{ message: { content: JSON.stringify({ directions: Array.from({ length: mode === "too_many" ? 4 : 1 }, (_, index) => ({ id: index ? `extra-${index}` : "character-reference", columnId: mode === "unknown_column" ? "nonexistent-column" : "practice", eventKey: "character-reference-workflow",
    question: "连续镜头角色总变脸，先检查哪一步？", viewerBenefit: "学会固定角色参考，减少分镜间的角色漂移", whyNow: "两份材料补足流程与限制",
    angle: "先固定参考，再生成镜头，讲清适用条件", usage: { steps: ["准备角色参考", "逐镜生成并检查"], conditions: ["有可用角色图"], limitations: ["没有实测保证"] },
    titles: ["角色总变脸？先固定参考图", "连续镜头如何保住同一个角色", "做AI漫剧，先把角色参考这步做对"], preferredTitle: mode === "invalid_title" ? 99 : 0,
    structure: { opening: "先展示角色漂移问题", rhythm: "问题、操作、结果与限制", ending: "给出适用条件与下一步" },
    references: ids.map((materialId: string) => ({ materialId, role: "fact", quote: mode === "invented_quote" ? "角色一致性提升十倍，已经实测。" : "先固定参考图，再生成镜头。", reason: "对应制作步骤" })),
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 80, demand: 100, distinctiveness: 70 }, gates: { audience: true, evidence: true, benefit: true },
  })), assignments: mode === "missing_assignment" ? [] : ids.map((materialId: string) => ({ materialId, columnId: "practice", disposition: "support", directionIds: [mode === "orphan_direction" ? "invented-direction" : "character-reference"], reason: "同一流程的补充依据" })) }) } }],
    usage: { prompt_tokens: 30, completion_tokens: 30 } };
});

async function prepareCase(t: TestContext, name: string, analyze = true) {
  const now = new Date(Date.parse("2026-10-18T12:00:00Z") + ++caseNumber * 48 * 3600_000), start = new Date(now.getTime() - 48 * 3600_000);
  t.mock.timers.enable({ apis: ["Date"], now }); await resources.warm(); config.modelCallsEnabled = true;
  await upsertMaterial({ sourceId: "direction-news-0", title: name, url: `https://direction-0.example/case-${caseNumber}`, via: "import",
    discoveredAt: new Date(start.getTime() + 3600_000), publishedAt: start, bodyText: "先固定参考图，再生成镜头。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start.toISOString() } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id;
  if (!analyze) return `/api/admin/studio/topic-batches/${batchId}/recommendations`;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${batchId}/analysis`, headers, payload: {} })).json().queuedCount, 1);
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  return `/api/admin/studio/topic-batches/${batchId}/recommendations`;
}

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "directions-test-key", LLM_MODEL: "directions-test-model" });
after(async () => { await stopWorker?.(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("冻结的多条材料合成一个有七点交付的方向，所有材料仍有归属，草案未审核且读取不重复生成", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  await resources.warm(); config.modelCallsEnabled = true;
  const ids: string[] = [], bodies: string[] = [];
  for (let index = 0; index < 2; index++) {
    const sourceId = `direction-news-${index}`;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: sourceId, name: `角色制作来源${index}`, kind: "rss", config: { feedUrl: `https://direction-${index}.example/feed` } } })).statusCode, 200);
    const body = `先固定参考图，再生成镜头。${"具体步骤与限制，不承诺实测效果。".repeat(30)}结尾依据${index}。`; bodies.push(body);
    const saved = await upsertMaterial({ sourceId, title: `角色参考${index}`, url: `https://direction-${index}.example/one`, via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
    ids.push("news:" + saved.articleId);
  }
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id;
  const url = `/api/admin/studio/topic-batches/${batchId}/recommendations`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers })).json().state, "not_generated");
  const analysis = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${batchId}/analysis`, headers, payload: {} });
  assert.equal(analysis.statusCode, 200); assert.equal(analysis.json().queuedCount, 2);
  const boss = await getBoss();
  for (let index = 0; index < 2; index++) { const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job); await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.ok(submitted.json().jobId);
  const [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const result = await app.inject({ url, headers });
  assert.equal(result.statusCode, 200); assert.equal(result.headers["cache-control"], "no-store");
  const value = result.json(); assert.equal(value.state, "draft"); assert.equal(value.reviewState, "not_started");
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}`, headers })).json().batch.recommendationState, "draft");
  assert.equal(value.result.directions.length, 1); assert.equal(value.result.assignments.length, 2);
  assert.deepEqual(new Set(value.result.assignments.map((item: { materialId: string }) => item.materialId)), new Set(ids));
  const direction = value.result.directions[0];
  assert.equal(direction.columnId, "practice"); assert.equal(direction.titles.length, 3); assert.equal(direction.preferredTitle, 0);
  assert.equal(direction.references.length, 2); assert.equal(direction.usage.steps.length, 2);
  assert.equal(value.referenceMaterials.length, 2);
  assert.ok(value.referenceMaterials.some((item: { title: string; url: string }) => item.title === "角色参考0" && item.url === "https://direction-0.example/one"));
  // No observed heat, grounded event time or impact was supplied: new weights must not invent their contributions.
  assert.equal(direction.score.ranking.baseTotal, 29); assert.equal(direction.score.total, 29); assert.equal(direction.score.scope, "direction"); assert.equal(direction.score.dimensions.demand, null);
  assert.equal(direction.score.eligible, true); assert.ok(value.receiptId > 0);
  const generatedInput = requests.at(-1)!.messages.find(message => message.role === "user")!.content;
  assert.ok(generatedInput.includes("关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者"));
  assert.ok(bodies.every(body => JSON.parse(generatedInput).materials.some((row: { material: { body: string } }) => row.material.body === body)), "完整正文不能被模型摘要替换");
  const hitCount = requests.length;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  assert.equal((await app.inject({ url, headers })).json().result.directions.length, 1); assert.equal(requests.length, hitCount);
});

test("综合结果遗漏任意冻结材料的去向时拒绝整份草案，不能冒充全部已筛选", async t => {
  const url = await prepareCase(t, "覆盖遗漏"); mode = "missing_assignment";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.state, "failed"); assert.equal(result.result, null); assert.equal(result.reviewState, "not_started");
  assert.ok(result.error); mode = "valid";
});

test("综合方向引用不存在的原文结论时拒绝保存，不能把模型猜测当事实证据", async t => {
  const url = await prepareCase(t, "虚构方向引文"); mode = "invented_quote";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.state, "failed"); assert.equal(result.result, null); mode = "valid";
});

test("模型超过快照栏目的方向数量上限时拒绝结果，不静默截掉方向或关联材料", async t => {
  const url = await prepareCase(t, "方向数量超限"); mode = "too_many";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().result, null); mode = "valid";
});

test("材料声称被用于不存在的方向时不能通过覆盖检查，方向和依据必须双向对应", async t => {
  const url = await prepareCase(t, "无效材料关联"); mode = "orphan_direction";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().result, null); mode = "valid";
});

test("材料初筛尚未完成时不提前生成草案，缺口不能被当成没有方向", async t => {
  const url = await prepareCase(t, "未完成初筛", false), count = requests.length;
  const response = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(response.statusCode, 409);
  assert.equal((await app.inject({ url, headers })).json().state, "not_generated");
  assert.equal(requests.length, count);
});

test("方向不能使用冻结快照以外的栏目，新配置不能悄悄改变历史标准", async t => {
  const url = await prepareCase(t, "未知方向栏目"); mode = "unknown_column";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().result, null); mode = "valid";
});

test("被取消的综合任务显示失败且只在显式重试时恢复，活跃任务和成功草案不重复排队", async t => {
  const url = await prepareCase(t, "综合任务恢复"); mode = "valid";
  const response = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(response.statusCode, 200); const id = response.json().jobId;
  const boss = await getBoss(); await boss.cancel("studio.topic.generate", id);
  assert.equal((await app.inject({ url, headers })).json().state, "failed");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  const retried = await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } });
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().queued, true); assert.notEqual(retried.json().jobId, id);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queued, false);
  const [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "draft");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queued, false);
});

test("启用计划后完成初筛的批次自动排综合任务，重复调度不重排，未完成初筛和失败批次不自动复活", async t => {
  const url = await prepareCase(t, "自动综合方向"); mode = "valid";
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: plan.version, enabled: true, startsAt: plan.startsAt } })).statusCode, 200);
  const schedule = studio.schedules?.find(item => item.name === "studio.topic.generate.schedule");
  assert.ok(schedule, "自动截止后必须能接续综合方向，不依赖人工逐批提交");
  assert.deepEqual(await schedule.run(), { queued: 1 }); assert.deepEqual(await schedule.run(), { queued: 0 });
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  assert.equal((job.data as { batchId: string }).batchId, url.split("/").at(-2));
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "draft");
  assert.deepEqual(await schedule.run(), { queued: 0 });
});

test("没有材料的批次保存空草案与明确状态，不调用模型凑方向", async t => {
  const now = new Date(Date.parse("2026-10-18T12:00:00Z") + ++caseNumber * 48 * 3600_000);
  t.mock.timers.enable({ apis: ["Date"], now }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers,
    payload: { startsAt: new Date(now.getTime() - 48 * 3600_000).toISOString() } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 0);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/recommendations`, hits = requests.length;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.state, "draft"); assert.deepEqual(result.result, { directions: [], assignments: [] }); assert.equal(result.receiptId, null);
  assert.equal(requests.length, hits);
});

test("首选标题必须确实存在于标题建议中，不能交付无法显示或选择的标题", async t => {
  const url = await prepareCase(t, "无效首选标题"); mode = "invalid_title";
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.topic.generate"); assert.ok(job);
  const { topicGenerationQueue } = await import("../backend/topic-directions.ts");
  await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /unusable output/);
  await boss.fail(topicGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().result, null); mode = "valid";
});

test("综合消费者在模型关闭或低磁盘时保留原任务，恢复并重启消费者后只生成一次草案", { timeout: 20_000 }, async t => {
  const url = await prepareCase(t, "综合资源等待"); mode = "valid";
  const response = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(response.statusCode, 200); const id = response.json().jobId, hits = requests.length;
  const { createTopicGenerationQueue } = await import("../backend/topic-directions.ts");
  const queue = createTopicGenerationQueue(resources.host, resources.disk, resources.database), boss = await getBoss();
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  config.modelCallsEnabled = false; stopWorker = await workModuleQueues(boss); await resources.warm();
  await delay(2100); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created"); assert.equal(requests.length, hits);
  config.modelCallsEnabled = true; resources.capacity.diskBytes = 5_000_000_000; await resources.disk.sample();
  await delay(2100); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created"); assert.equal(requests.length, hits);
  await stopWorker(); resources.capacity.diskBytes = 6_000_000_000;
  stopWorker = await workModuleQueues(boss); await resources.warm();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await boss.findJobs(queue.name, { id }))[0]!.state !== "completed") await delay(30);
  const result = (await boss.findJobs(queue.name, { id }))[0]!;
  assert.equal(result.state, "completed"); assert.equal(result.retryCount, 0); assert.equal(requests.length, hits + 1);
  assert.equal((await app.inject({ url, headers })).json().state, "draft");
  await stopWorker(); stopWorker = undefined;
});
