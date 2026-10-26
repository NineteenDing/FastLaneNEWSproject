import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only controlled localhost provider fixtures in this test process.
let stop: (() => Promise<void>) | undefined;
const body = "使用同一张角色参考图生成连续镜头。步骤和适用条件完整保留。" + "正文中的制作约束。".repeat(100) + "最后一段：仅适用于固定角色。";
const requests: { messages: Array<{ role: string; content: string }> }[] = [];
const provider = await stub((_hit, request) => {
  requests.push(JSON.parse(request.body));
  const input = JSON.parse(requests.at(-1)!.messages.find(message => message.role === "user")!.content);
  return { id: "studio-material-analysis-response", choices: [{ message: { content: JSON.stringify({
    columnId: input.material.title === "无效栏目测试" ? "invented-column" : "practice", disposition: input.material.title === "不形成选题" ? "not_topic" : "support", summary: "固定角色参考再生成连续镜头", reason: "给出具体制作步骤和限制",
    viewerBenefit: input.material.title === "没有观看收益" ? null : "减少连续镜头中的角色漂移", event: "固定角色参考工作流", evidenceQuotes: [input.material.title === "虚构引文测试" ? "原材料未说过：效果提升十倍。" : "使用同一张角色参考图生成连续镜头。"],
    gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 90, evidence: 70, freshness: 60, demand: input.material.title === "没有需求信号" ? 100 : null, distinctiveness: 50 },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
});

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-topic-material-key", LLM_MODEL: "isolated-material-model" });
after(async () => { await stop?.(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("完整冻结材料经持久任务调用模型，按保存规则归类和初筛，缺失需求不填零也不补权重，读取和重试不重复付费", { timeout: 20_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  const absent = await app.inject({ url: "/api/admin/studio/topic-batches/00000000-0000-4000-8000-000000000001/analysis" });
  assert.equal(absent.statusCode, 401);
  await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "material-analysis-news", name: "角色制作实验室", kind: "rss", config: { feedUrl: "https://material-analysis.example/feed" } } })).statusCode, 200);
  const material = await upsertMaterial({ sourceId: "material-analysis-news", title: "角色参考工作流", url: "https://material-analysis.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const id = frozen.json().batch.id;
  const url = `/api/admin/studio/topic-batches/${id}/analysis`;
  const initial = await app.inject({ url, headers });
  assert.equal(initial.statusCode, 200); assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().total, 1); assert.equal(initial.json().analyzed, 0); assert.equal(requests.length, 0);
  config.modelCallsEnabled = true;
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.ok(submitted.json().jobId); assert.equal(requests.length, 0);
  const { createTopicAnalysisQueue } = await import("../backend/topic-material-analysis.ts");
  const queue = createTopicAnalysisQueue(resources.host, resources.disk, resources.database);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const boss = await getBoss(); stop = await workModuleQueues(boss); await resources.warm();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().analyzed !== 1) await delay(30);
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.analyzed, 1); assert.equal(result.pending, 0);
  assert.equal(result.rows[0].materialId, "news:" + material.articleId);
  assert.equal(result.rows[0].columnId, "practice"); assert.equal(result.rows[0].disposition, "support");
  assert.equal(result.rows[0].score.total, 67.5);
  assert.equal(result.rows[0].score.dimensions.demand, null);
  assert.equal(result.rows[0].score.eligible, true);
  assert.deepEqual(result.rows[0].score.gaps, ["缺少可比较的关注需求信号"]);
  assert.equal(result.rows[0].receiptId > 0, true);
  assert.equal(result.rows[0].scope, "material_initial");
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.messages.some(message => message.content.includes(body)), "正文不可静默截断");
  assert.ok(requests[0]!.messages.some(message => message.content.includes("关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者")));
  assert.ok(requests[0]!.messages.some(message => message.content.includes("怎样完成某项创作或减少返工")));
  const again = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(again.statusCode, 200); assert.equal(again.json().queued, false);
  assert.equal((await app.inject({ url, headers })).json().rows[0].score.total, 67.5); assert.equal(requests.length, 1);
});

test("模型不能把材料写进未启用或不存在的栏目，错误保留为失败并不算已分析", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "无效栏目测试", url: "https://material-analysis.example/invalid-column", via: "import",
    discoveredAt: new Date("2026-10-19T10:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const row = (await app.inject({ url, headers })).json().rows[0];
    if (["failed", "completed"].includes(row.state)) break;
    await delay(30);
  }
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.rows[0].state, "failed");
  assert.equal(result.analyzed, 0); assert.equal(result.pending, 1);
  assert.ok(result.rows[0].error); assert.equal(result.rows[0].columnId, undefined);
});

test("模型虚构原文引句时不保存为证据，不因高分变成已分析材料", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "虚构引文测试", url: "https://material-analysis.example/invalid-quote", via: "import",
    discoveredAt: new Date("2026-10-21T10:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-20T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const row = (await app.inject({ url, headers })).json().rows[0];
    if (["failed", "completed"].includes(row.state)) break;
    await delay(30);
  }
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.rows[0].state, "failed"); assert.equal(result.analyzed, 0);
  assert.equal(result.rows[0].evidenceQuotes, undefined);
});

test("没有实际需求依据时模型给满分也保留未知，不能借此抬高初筛分", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "没有需求信号", url: "https://material-analysis.example/missing-demand", via: "import",
    discoveredAt: new Date("2026-10-23T10:00:00Z"), publishedAt: new Date("2026-10-23T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-22T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().analyzed !== 1) await delay(30);
  const row = (await app.inject({ url, headers })).json().rows[0];
  assert.equal(row.score.dimensions.demand, null); assert.equal(row.score.total, 67.5);
  assert.equal(row.dimensions.demand, null);
});

test("只取得摘要的材料可以归类，但模型声称证据齐全也必须保留待处理和不入选状态", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "正文尚未完整取得", url: "https://material-analysis.example/body-pending", via: "import",
    discoveredAt: new Date("2026-10-25T10:00:00Z"), excerpt: body, bodyStatus: "pending" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().rows[0].state !== "completed") await delay(30);
  const result = (await app.inject({ url, headers })).json();
  assert.equal(result.rows[0].columnId, "practice");
  assert.equal(result.rows[0].disposition, "pending"); assert.equal(result.rows[0].score.eligible, false);
  assert.equal(result.analyzed, 0); assert.equal(result.pending, 1);
  assert.ok(result.rows[0].gaps.includes("正文或转写尚未完整取得"));
});

test("发布时间未知不能用收录时间冒充新鲜度，未知维度保留缺口且不补权重", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "发布时间未知", url: "https://material-analysis.example/unknown-date", via: "import",
    discoveredAt: new Date("2026-10-27T10:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-26T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().analyzed !== 1) await delay(30);
  const row = (await app.inject({ url, headers })).json().rows[0];
  assert.equal(row.score.dimensions.freshness, null); assert.equal(row.score.total, 61.5);
  assert.ok(row.gaps.includes("发布时间尚未核实"));
});

test("没有明确观看收益即使模型门槛标记通过也不具备初筛入选资格", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-30T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "没有观看收益", url: "https://material-analysis.example/no-benefit", via: "import",
    discoveredAt: new Date("2026-10-29T10:00:00Z"), publishedAt: new Date("2026-10-29T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-28T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().analyzed !== 1) await delay(30);
  const row = (await app.inject({ url, headers })).json().rows[0];
  assert.equal(row.score.eligible, false); assert.equal(row.gates.benefit, false);
});

test("暂不成题材料保留栏目和初筛依据，但不能因数值高而取得候选资格", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
  await resources.warm();
  await upsertMaterial({ sourceId: "material-analysis-news", title: "不形成选题", url: "https://material-analysis.example/not-topic", via: "import",
    discoveredAt: new Date("2026-10-31T10:00:00Z"), publishedAt: new Date("2026-10-31T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-30T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 200);
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await app.inject({ url, headers })).json().analyzed !== 1) await delay(30);
  const row = (await app.inject({ url, headers })).json().rows[0];
  assert.equal(row.disposition, "not_topic"); assert.equal(row.columnId, "practice");
  assert.equal(row.score.eligible, false); assert.equal(row.score.total, 67.5);
});
