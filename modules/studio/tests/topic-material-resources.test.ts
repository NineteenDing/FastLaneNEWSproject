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
import { createTopicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only this process's controlled localhost model stub.
let stop: (() => Promise<void>) | undefined;
const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
  summary: "保留角色参考", reason: "存在操作依据", viewerBenefit: "减少角色漂移", event: "角色参考", evidenceQuotes: ["保留角色参考。"],
  gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
}) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "resource-analysis-test-key", LLM_MODEL: "resource-analysis-test-model" });
after(async () => { await stop?.(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("模型关闭或低磁盘时付费分析任务保持原ID零重试，消费者重启后恢复并只调用一次模型", { timeout: 20_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "analysis-resources", name: "分析资源测试", kind: "rss", config: { feedUrl: "https://analysis-resources.example/feed" } } })).statusCode, 200);
  await upsertMaterial({ sourceId: "analysis-resources", title: "角色控制", url: "https://analysis-resources.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "保留角色参考。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  config.modelCallsEnabled = true;
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); const id = submitted.json().jobId;
  const queue = createTopicAnalysisQueue(resources.host, resources.disk, resources.database);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const boss = await getBoss();
  config.modelCallsEnabled = false;
  stop = await workModuleQueues(boss); await resources.warm();
  await delay(2100);
  assert.equal(provider.hits(), 0); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created");
  config.modelCallsEnabled = true; resources.capacity.diskBytes = 5_000_000_000; await resources.disk.sample();
  await delay(2100);
  assert.equal(provider.hits(), 0); assert.equal((await boss.findJobs(queue.name, { id }))[0]!.state, "created");
  await stop();
  resources.capacity.diskBytes = 6_000_000_000;
  stop = await workModuleQueues(boss); await resources.warm();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline && (await boss.findJobs(queue.name, { id }))[0]!.state !== "completed") await delay(30);
  const finished = (await boss.findJobs(queue.name, { id }))[0]!;
  assert.equal(finished.state, "completed"); assert.equal(finished.retryCount, 0); assert.equal(provider.hits(), 1);
  assert.equal((await app.inject({ url, headers })).json().analyzed, 1);
});
