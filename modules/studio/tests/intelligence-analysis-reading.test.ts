import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only this process's controlled localhost model stub.
const body = "先固定角色参考，再逐镜头检查一致性。";
const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
  summary: "角色参考与逐镜头检查", reason: "可以演示具体操作", viewerBenefit: "减少角色漂移", event: "角色检查方法",
  evidenceQuotes: [body], entities: [], gates: { audience: true, evidence: true, benefit: true },
  dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
}) } }], usage: { prompt_tokens: 50, completion_tokens: 50 } }));
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-reading-key", LLM_MODEL: "isolated-reading-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("情报列表和当期数量反映同版实际初筛，详情读取已有结果不调用模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "analysis-reading", name: "分析阅读来源", kind: "rss", config: { feedUrl: "https://analysis-reading.example/feed" },
  } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "analysis-reading", title: "角色检查", url: "https://analysis-reading.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const id = "news:" + saved.articleId;
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows[0].analysisState, "pending");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json().analysisPendingCount, 1);
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  const list = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json(); assert.equal(list.rows[0].analysisState, "completed");
  const detail = await app.inject({ url: `/api/admin/studio/intelligence/${id}`, headers });
  assert.equal(detail.statusCode, 200); assert.equal(detail.headers["cache-control"], "no-store");
  assert.equal(detail.json().analysis.result.summary, "角色参考与逐镜头检查");
  assert.equal(detail.json().analysis.result.columnSnapshot.name, "实操与提效");
  assert.equal(detail.json().analysis.materialId, id); assert.equal(detail.json().analysis.state, "completed");
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal(current.materialCount, 1); assert.equal(current.analysisCompletedCount, 1); assert.equal(current.analysisPendingCount, 0);
  const preview = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json();
  assert.equal(preview.rows[0].analysis.state, "completed");
  assert.equal(preview.rows[0].analysis.result.summary, "角色参考与逐镜头检查");
  assert.equal(provider.hits(), 1);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${id}` })).statusCode, 401);
});

test("情报跟随同版批次接管，更正后的正文不混用冻结分析，旧批次保留原稿", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const id = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows[0].id;
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id, prefix = `/api/admin/studio/topic-batches/${batchId}`;
  const submitted = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); assert.equal(submitted.statusCode, 200);
  const queued = (await app.inject({ url: `/api/admin/studio/intelligence/${id}/analysis`, headers })).json();
  assert.equal(queued.state, "queued"); assert.equal(queued.batchId, batchId); assert.equal(queued.batchOwnsVersion, true); assert.equal(queued.origin, "batch");
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  assert.equal(provider.hits(), 1);
  await upsertMaterial({ sourceId: "analysis-reading", title: "角色检查", url: "https://analysis-reading.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body + "补充：仅适用于固定角色。", bodyStatus: "ok" });
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${id}`, headers })).json();
  assert.equal(detail.analysis.state, "pending"); assert.equal(detail.analysis.result, null); assert.equal(detail.analysis.origin, "live");
  assert.equal(detail.analysis.batchOwnsVersion, false); assert.equal(detail.analysis.batchId, batchId);
  assert.ok(detail.body.includes("补充"));
  const old = (await app.inject({ url: prefix + "/materials", headers })).json().rows[0];
  assert.equal(old.body, body); assert.equal(old.analysis, undefined);
  assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().rows[0].summary, "角色参考与逐镜头检查");
  assert.equal(provider.hits(), 1);
});
