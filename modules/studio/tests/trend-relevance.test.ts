import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { setTimeout as delay } from "node:timers/promises";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { createModelAdmission } from "../backend/model-admission.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let invalidQuote = false;
let beforeAnswer: (() => Promise<void>) | undefined;
const provider = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body); requests.push(body);
  const input = JSON.parse(body.messages.at(-1).content);
  const title = input.signal.title;
  await beforeAnswer?.();
  const decision = title.includes("足球") ? "excluded" : title.includes("谜题") ? "uncertain" : "relevant";
  return { choices: [{ message: { content: JSON.stringify({ decision,
    reason: decision === "relevant" ? "标题提及人物一致性，值得查原文确认具体制作步骤" : decision === "excluded" ? "体育赛果不服务AI影视制作" : "标题信息不足，不能凭热度推断创作用途",
    titleQuote: invalidQuote ? "原题中不存在的证据" : title, viewerProblem: decision === "relevant" ? "多镜头中保持角色一致" : null }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 60 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "trend-relevance-isolated", LLM_MODEL: "isolated-trend" });
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("热榜按固定受众逐条判断并保存排除和待核实理由，同版复用且不把标题变成事实材料", async () => {
  const path = "/api/admin/studio/trends/relevance";
  assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { unknown: true } })).statusCode, 400);
  config.modelCallsEnabled = false;
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).statusCode, 409);
  config.modelCallsEnabled = true;
  const boards = "/api/admin/studio/trends/boards";
  assert.equal((await app.inject({ method: "POST", url: boards + "/bilibili", headers, payload: {} })).statusCode, 200);
  const board = (await app.inject({ url: boards, headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers,
    payload: { version: board.source.version, enabled: true } })).statusCode, 200);
  const titles = ["AI视频人物一致性方法", "足球决赛回顾", "今天的谜题"];
  const list = titles.map((title, index) => ({ bvid: `BV1${index}411c7mD8`, title, stat: { view: 100000 } }));
  const collectQueue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.collect")!;
  async function collect() {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, { code: 0, data: { list } });
    assert.equal((await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} })).statusCode, 200);
    const boss = await getBoss(), [job] = await boss.fetch(collectQueue.name); assert.ok(job);
    await collectQueue.run([job.data] as never[]); await boss.complete(collectQueue.name, job.id);
  }
  await collect();
  const submitted = await app.inject({ method: "POST", url: path, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queuedCount, 3);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  assert.ok(queue); const boss = await getBoss(), jobs = await boss.fetch(queue.name, { batchSize: 10 }); assert.equal(jobs.length, 3);
  for (const job of jobs) { await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); }
  const saved = await app.inject({ url: "/api/admin/studio/trends/signals", headers });
  assert.equal(saved.headers["cache-control"], "no-store");
  for (const [index, disposition] of ["awaiting_deep_read", "excluded", "needs_verification"].entries()) {
    const row = saved.json().rows.find((row: { title: string }) => row.title === titles[index]);
    assert.equal(row.disposition, disposition); assert.equal(row.relevance.state, "completed");
    assert.ok(row.relevance.result.reason); assert.equal(row.relevance.result.titleQuote, titles[index]); assert.ok(row.relevance.receiptId);
  }
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const input = JSON.parse(request.messages.at(-1)!.content);
    assert.equal(input.audience, "关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者");
    assert.equal(input.signal.metrics, undefined, "初筛不因播放高就认定相关或已核实");
    assert.match(request.messages[0]!.content, /标题|待核实/);
  }
  await collect();
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  assert.equal(requests.length, 3, "只有排名热度变化不重复付费判断");
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().total, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  transport.assertNoPendingInterceptors();
});

test("模型编造标题依据不能通过，失败不自动反复付费，显式重试取得新回答并记录分析费用", async () => {
  const path = "/api/admin/studio/trends/relevance", boards = "/api/admin/studio/trends/boards";
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200,
    { code: 0, data: { list: [{ bvid: "BV1A411c7mD8", title: "AI视频开头与人物一致性", stat: {} }] } });
  const module = SERVER_MODULES.find(module => module.name === "studio")!, boss = await getBoss();
  const collectQueue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, queue = module.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  await app.inject({ method: "POST", url: boards + "/bilibili/check", headers, payload: {} });
  const [collect] = await boss.fetch(collectQueue.name); assert.ok(collect); await collectQueue.run([collect.data] as never[]); await boss.complete(collectQueue.name, collect.id);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [job] = await boss.fetch(queue.name); assert.ok(job); invalidQuote = true;
  try { await assert.rejects(queue.run([job.data] as never[]), /判断未完成/); await boss.cancel(queue.name, job.id); }
  finally { invalidQuote = false; }
  let row = (await app.inject({ url: "/api/admin/studio/trends/signals?q=开头", headers })).json().rows[0];
  assert.equal(row.relevance.state, "failed"); assert.equal(row.relevance.result, null); assert.equal(row.disposition, "pending_relevance");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  const retried = await app.inject({ method: "POST", url: path, headers, payload: { retryFailed: true } });
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().queuedCount, 1);
  const [retry] = await boss.fetch(queue.name); assert.ok(retry); await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
  row = (await app.inject({ url: "/api/admin/studio/trends/signals?q=开头", headers })).json().rows[0];
  assert.equal(row.relevance.state, "completed"); assert.equal(row.disposition, "awaiting_deep_read");
  assert.equal(row.relevance.result.titleQuote, row.title); assert.equal(requests.length, 5);
  const usage = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
  assert.equal(usage.rows.find((row: { key: string }) => row.key === "analysis").attemptsThisMonth, 5);
  transport.assertNoPendingInterceptors();
});

test("原标题改动后未发送的任务不再付费，已发送的旧回答不覆盖新标题，并可复用旧版成功结果", async () => {
  const path = "/api/admin/studio/trends/relevance", module = SERVER_MODULES.find(module => module.name === "studio")!, boss = await getBoss();
  const collectQueue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, queue = module.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  const baseCount = requests.length;
  async function collectTitle(title: string) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200,
      { code: 0, data: { list: [{ bvid: "BV1A411c7mD8", title, stat: {} }] } });
    await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} });
    const [job] = await boss.fetch(collectQueue.name); assert.ok(job); await collectQueue.run([job.data] as never[]); await boss.complete(collectQueue.name, job.id);
  }
  await collectTitle("AI视频人物一致性旧版");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [old] = await boss.fetch(queue.name); assert.ok(old);
  await collectTitle("AI视频人物一致性新版");
  await queue.run([old.data] as never[]); await boss.complete(queue.name, old.id);
  assert.equal(requests.length, baseCount, "执行前已过时的标题不发送模型");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [pending] = await boss.fetch(queue.name); assert.ok(pending);
  beforeAnswer = async () => { await collectTitle("AI视频人物一致性更正版"); };
  try { await queue.run([pending.data] as never[]); await boss.complete(queue.name, pending.id); }
  finally { beforeAnswer = undefined; }
  const current = (await app.inject({ url: "/api/admin/studio/trends/signals?q=更正版", headers })).json().rows[0];
  assert.equal(current.disposition, "pending_relevance"); assert.equal(current.relevance, null);
  assert.equal(requests.length, baseCount + 1);
  await collectTitle("AI视频人物一致性新版");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  const reused = (await app.inject({ url: "/api/admin/studio/trends/signals?q=新版", headers })).json().rows[0];
  assert.equal(reused.relevance.state, "completed"); assert.equal(reused.relevance.result.titleQuote, reused.title);
  assert.equal(requests.length, baseCount + 1);
  await collectTitle("AI视频人物一致性旧版");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1, "从未发送的旧版不能被永久遗留的队列状态卡住");
  const [resumed] = await boss.fetch(queue.name); assert.ok(resumed); await queue.run([resumed.data] as never[]); await boss.complete(queue.name, resumed.id);
  transport.assertNoPendingInterceptors();
});

test("热榜判断队列复用模型暂停和6GB磁盘恢复准入，等待保留同一任务且不消耗重试", { timeout: 20_000 }, async () => {
  const path = "/api/admin/studio/trends/relevance", module = SERVER_MODULES.find(module => module.name === "studio")!, boss = await getBoss();
  const collectQueue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, original = module.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200,
    { code: 0, data: { list: [{ bvid: "BV1B411c7mD8", title: "AI视频人物一致性资源等待", stat: {} }] } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} });
  const [collect] = await boss.fetch(collectQueue.name); assert.ok(collect); await collectQueue.run([collect.data] as never[]); await boss.complete(collectQueue.name, collect.id);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const queue = { ...original, admission: createModelAdmission({ host: resources.host, disk: resources.disk, database: resources.database }) };
  const [job] = (await boss.findJobs(queue.name)).filter(job => job.state === "created"); assert.ok(job);
  const previousRequests = requests.length;
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers, payload: { version: 0, enabled: false } })).statusCode, 200);
  let stop = await workModuleQueues(boss); await resources.warm();
  try {
    await delay(2100);
    assert.equal(requests.length, previousRequests); assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "created");
    resources.capacity.diskBytes = 5_900_000_000; await resources.disk.sample();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers, payload: { version: 1, enabled: true } })).statusCode, 200);
    await delay(2100);
    assert.equal(requests.length, previousRequests); assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "created");
    await stop(); resources.capacity.diskBytes = 6_000_000_000;
    stop = await workModuleQueues(boss); await resources.warm();
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline && (await boss.findJobs(queue.name, { id: job.id }))[0]!.state !== "completed") await delay(30);
    const finished = (await boss.findJobs(queue.name, { id: job.id }))[0]!;
    assert.equal(finished.state, "completed"); assert.equal(finished.retryCount, 0); assert.equal(requests.length, previousRequests + 1);
    assert.equal((await app.inject({ url: "/api/admin/studio/trends/signals?q=资源等待", headers })).json().rows[0].relevance.state, "completed");
  } finally { await stop(); installModules(SERVER_MODULES); }
  transport.assertNoPendingInterceptors();
});

test("队列终止但业务回执未完成时如实显示失败，显式恢复后旧任务不能消费新执行权", async () => {
  const path = "/api/admin/studio/trends/relevance", module = SERVER_MODULES.find(module => module.name === "studio")!, boss = await getBoss();
  const collectQueue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, queue = module.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200,
    { code: 0, data: { list: [{ bvid: "BV1C411c7mD8", title: "AI视频人物一致性恢复任务", stat: {} }] } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} });
  const [collect] = await boss.fetch(collectQueue.name); assert.ok(collect); await collectQueue.run([collect.data] as never[]); await boss.complete(collectQueue.name, collect.id);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [old] = await boss.fetch(queue.name); assert.ok(old); await boss.cancel(queue.name, old.id);
  const failed = (await app.inject({ url: "/api/admin/studio/trends/signals?q=恢复任务", headers })).json().rows[0];
  assert.equal(failed.relevance.state, "failed"); assert.ok(failed.relevance.error); assert.equal(failed.relevance.result, null);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { retryFailed: true } })).json().queuedCount, 1);
  const before = requests.length;
  await queue.run([old.data] as never[]); assert.equal(requests.length, before);
  const [retry] = await boss.fetch(queue.name); assert.ok(retry); await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
  assert.equal((await app.inject({ url: "/api/admin/studio/trends/signals?q=恢复任务", headers })).json().rows[0].relevance.state, "completed");
  assert.equal(requests.length, before + 1); transport.assertNoPendingInterceptors();
});

test("过时任务尚未确认完成时原标题恢复，之后能自动继续判断而不永久停留待处理", async () => {
  const path = "/api/admin/studio/trends/relevance", module = SERVER_MODULES.find(module => module.name === "studio")!, boss = await getBoss();
  const collectQueue = module.queues!.find(queue => queue.name === "studio.trends.collect")!, queue = module.queues!.find(queue => queue.name === "studio.trends.relevance")!;
  async function collect(title: string) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200,
      { code: 0, data: { list: [{ bvid: "BV1D411c7mD8", title, stat: {} }] } });
    await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} });
    const [job] = await boss.fetch(collectQueue.name); assert.ok(job); await collectQueue.run([job.data] as never[]); await boss.complete(collectQueue.name, job.id);
  }
  await collect("AI视频原版人物一致性");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [old] = await boss.fetch(queue.name); assert.ok(old);
  await collect("AI视频临时更正标题");
  const before = requests.length; await queue.run([old.data] as never[]); assert.equal(requests.length, before);
  await collect("AI视频原版人物一致性");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 0);
  await boss.complete(queue.name, old.id);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).json().queuedCount, 1);
  const [resumed] = await boss.fetch(queue.name); assert.ok(resumed); await queue.run([resumed.data] as never[]); await boss.complete(queue.name, resumed.id);
  assert.equal((await app.inject({ url: "/api/admin/studio/trends/signals?q=原版", headers })).json().rows[0].relevance.state, "completed");
  assert.equal(requests.length, before + 1); transport.assertNoPendingInterceptors();
});
