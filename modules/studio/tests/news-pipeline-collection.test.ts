import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss, workModuleQueues, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { collectSource } from "@aihot/backend/sources/collect";
import { installModules, serverModules } from "@aihot/backend/modules";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { createTopicAnalysisQueue, scheduleTopicMaterialAnalyses } from "../backend/topic-material-analysis.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("真实新闻和正文消费者只接Studio分析，网页暂停零模型请求，恢复后保存可读结果且不重复调用", { timeout: 30_000 }, async () => {
  const resources = await sourceResourceFixture(), { app, headers } = resources;
  const quote = "先整理角色参考图，再固定光线和镜头参数，减少连续分镜的人物漂移。";
  const body = quote.repeat(12);
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({
    columnId: "practice", disposition: "support", summary: "角色参考图与镜头检查", reason: "能演示具体操作",
    viewerBenefit: "减少连续镜头返工", event: "角色一致性方法", evidenceQuotes: [quote], entities: [],
    gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
  let base = "";
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", req.url === "/feed" ? "application/rss+xml" : "text/html");
    res.end(req.url === "/feed"
      ? `<rss><channel><item><title>角色参考图检查</title><link>${base}/article</link><description>具体镜头方法</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`
      : `<html><head><title>角色参考图检查</title></head><body><article><h1>角色参考图检查</h1><p>${body}</p></article></body></html>`);
  });
  base = await listenHttpForFetch(upstream);
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "pipeline-local-only", LLM_MODEL: "pipeline-local-model" });
  config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  // Replace only OS capacity/clock readings using the existing resource factory; handlers, queues,
  // receipts, storage, HTTP routes and the source/body readers all run unchanged against real PG.
  const analysis = createTopicAnalysisQueue(resources.host, resources.disk, resources.database);
  installModules(serverModules().map(module => module.name !== "studio" ? module : {
    ...module, queues: module.queues!.map(queue => queue.name === analysis.name ? analysis : queue),
  }));
  try {
    const paused = await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers, payload: { version: 0, enabled: false } });
    assert.equal(paused.statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
      id: "pipeline-news", name: "本地新闻样本", kind: "rss", config: { feedUrl: `${base}/feed`, fetchPublicContent: true },
    } })).statusCode, 200);
    assert.equal((await collectSource("pipeline-news", { force: true })).status, "ok");
    const source = (await app.inject({ url: "/api/admin/sources/pipeline-news", headers })).json();
    const articleId = source.items[0].id as string, materialId = `news:${articleId}`;
    const boss = await getBoss();
    await registerSourceJobs(boss); await workModuleQueues(boss); await resources.warm();
    const waitFor = async (read: () => Promise<boolean>) => {
      const deadline = Date.now() + 8_000;
      while (!await read()) { assert.ok(Date.now() < deadline, "新闻处理应在受控队列内接续完成"); await delay(100); }
    };
    await waitFor(async () => (await app.inject({ url: `/api/admin/content/${articleId}`, headers })).json().article.body_status === "ok");
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
    const url = `/api/admin/studio/intelligence/${materialId}/analysis`;
    assert.equal((await app.inject({ url, headers })).json().state, "pending");
    assert.equal(provider.hits(), 0);
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers,
      payload: { version: paused.json().version, enabled: true } })).statusCode, 200);
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
    await waitFor(async () => (await app.inject({ url, headers })).json().state === "completed");
    const result = (await app.inject({ url, headers })).json();
    assert.ok(result.receiptId); assert.equal(result.result.summary, "角色参考图与镜头检查");
    assert.equal(provider.hits(), 1);
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
    await app.inject({ url, headers }); assert.equal(provider.hits(), 1, "阅读和重复计划不重复收费");
    assert.equal(await boss.getQueue(QUEUES.analyze), null);
    assert.equal(await boss.getQueue(QUEUES.group), null);
  } finally {
    await stopBoss(); await app.close(); await provider.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
