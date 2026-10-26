import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { setTimeout as delay } from "node:timers/promises";
import { stub } from "../../../tests/setup.ts";
import { createTopicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { createModelAdmission } from "../backend/model-admission.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const url = "/api/admin/studio/model-operations";
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("模型运行开关是私有持久状态，硬开关关闭时不能启用，暂停与恢复有版本保护", async () => {
  config.modelCallsEnabled = false;
  const first = await app.inject({ url, headers });
  assert.equal(first.statusCode, 200); assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.json().version, 0); assert.equal(first.json().runtimeAllowed, false); assert.equal(first.json().enabled, false);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 0, enabled: true } })).statusCode, 409);
  config.modelCallsEnabled = true;
  const paused = await app.inject({ method: "PUT", url, headers, payload: { version: 0, enabled: false } });
  assert.equal(paused.statusCode, 200); assert.equal(paused.json().version, 1); assert.equal(paused.json().enabled, false);
  assert.equal((await app.inject({ url, headers })).json().requestedEnabled, false);
  assert.equal((await app.inject({ url: "/api/admin/studio/model-connection", headers })).json().runtimeEnabled, false);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 0, enabled: true } })).statusCode, 409);
  const resumed = await app.inject({ method: "PUT", url, headers, payload: { version: 1, enabled: true } });
  assert.equal(resumed.statusCode, 200); assert.equal(resumed.json().version, 2); assert.equal(resumed.json().enabled, true);
  assert.equal((await app.inject({ url: "/api/admin/studio/model-connection", headers })).json().runtimeEnabled, true);
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload: { version: 2, enabled: false } })).statusCode, 403);
  config.modelCallsEnabled = false;
  assert.equal((await app.inject({ url, headers })).json().enabled, false);
});

test("任务已被交付后网页暂停，模型调用前仍再次检查，不因绕过领取阶段而产生请求", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const provider = await stub(() => ({ choices: [{ message: { content: "{}" } }] }));
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "operations-paused-key", LLM_MODEL: "operations-model" });
  try {
    // This test is declared before the queue-consumer test, so it owns the first batch.
    await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "paused-news", name: "暂停测试", kind: "rss", config: { feedUrl: "https://paused.example/feed" } } });
    await upsertMaterial({ sourceId: "paused-news", title: "暂停前已排队", url: "https://paused.example/one", via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "保留角色参考。", bodyStatus: "ok" });
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200);
    const analysisUrl = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 200);
    const queue = createTopicAnalysisQueue(resources.host, resources.disk, resources.database), boss = await getBoss();
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 2, enabled: false } })).statusCode, 200);
    try { await assert.rejects(queue.run([job.data] as never[]), /模型调用已暂停/); }
    finally { await boss.complete(queue.name, job.id); }
    assert.equal(provider.hits(), 0);
    assert.equal((await app.inject({ url: analysisUrl, headers })).json().analyzed, 0);
  } finally {
    const state = (await app.inject({ url, headers })).json();
    await app.inject({ method: "PUT", url, headers, payload: { version: state.version, enabled: true } });
    await provider.close();
  }
});

test("网页暂停后持久模型任务保持原ID零重试，消费者重建也不领取，恢复后接着完成", { timeout: 20_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
    summary: "角色参考", reason: "操作依据", viewerBenefit: "减少漂移", event: "角色参考", evidenceQuotes: ["保留角色参考。"],
    gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
  }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "operations-model-key", LLM_MODEL: "operations-model" });
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true; // The environment fallback now shares the guarded transport; this provider is a local fixture.
  let stop: (() => Promise<void>) | undefined;
  try {
    config.modelCallsEnabled = true; await resources.warm();
    await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "operations-news", name: "运行测试", kind: "rss", config: { feedUrl: "https://operations.example/feed" } } });
    await upsertMaterial({ sourceId: "operations-news", title: "角色参考", url: "https://operations.example/one", via: "import",
      discoveredAt: new Date("2026-10-19T10:00:00Z"), bodyText: "保留角色参考。", bodyStatus: "ok" });
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200);
    const analysisUrl = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
    const submitted = await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} }); assert.equal(submitted.statusCode, 200);
    const id = submitted.json().jobId, queue = createTopicAnalysisQueue(resources.host, resources.disk, resources.database);
    const current = (await app.inject({ url, headers })).json();
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: current.version, enabled: false } })).statusCode, 200);
    installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
    const boss = await getBoss(); stop = await workModuleQueues(boss); await resources.warm();
    await delay(2100);
    assert.equal(provider.hits(), 0); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created");
    assert.equal((await app.inject({ url: analysisUrl, headers })).json().modelEnabled, false);
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 409);
    await stop(); stop = await workModuleQueues(boss); await resources.warm();
    await delay(2100); assert.equal(provider.hits(), 0);
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: current.version + 1, enabled: true } })).statusCode, 200);
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline && (await boss.findJobs(queue.name, { id }))[0]!.state !== "completed") await delay(30);
    const finished = (await boss.findJobs(queue.name, { id }))[0]!;
    assert.equal(finished.state, "completed"); assert.equal(finished.retryCount, 0); assert.equal(provider.hits(), 1);
    assert.equal((await app.inject({ url: analysisUrl, headers })).json().analyzed, 1);
  } finally { await stop?.(); config.allowPrivateNetworkFetch = oldPrivate; await provider.close(); }
});

test("许可查询等待真实数据库锁时磁盘进入压力，查询恢复后仍不能放行新的模型工作", async () => {
  config.modelCallsEnabled = true;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { entered = resolve; });
  const blocker = sql.begin(async db => { await db`LOCK TABLE settings IN ACCESS EXCLUSIVE MODE`; entered(); await held; });
  const gate = createModelAdmission({ host: resources.host, disk: resources.disk, database: resources.database })();
  try {
    await locked; await resources.warm();
    const pending = gate.canStart();
    resources.capacity.diskBytes = 5_000_000_000; await resources.disk.sample();
    release(); await blocker;
    assert.equal(await pending, false);
  } finally {
    release(); await blocker; gate.stop(); resources.capacity.diskBytes = 20 * 1024 ** 3;
  }
});
