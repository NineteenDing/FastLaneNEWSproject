import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss, QueueDeferred } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue, scheduleTopicMaterialAnalyses } from "../backend/topic-material-analysis.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit local provider fixture; production guard remains enabled.
let invalidNext = false;
const body = "保留角色参考图，再检查镜头衔接。";
const provider = await stub(() => {
  if (invalidNext) { invalidNext = false; return { choices: [{ message: { content: "{}" } }] }; }
  return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "检查镜头衔接",
    reason: "可演示具体步骤", viewerBenefit: "减少镜头返工", event: "镜头检查", evidenceQuotes: [body], entities: [],
    gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-handoff-key", LLM_MODEL: "isolated-handoff-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("截止时采中任务仍在途，等待后接管失败，不能通过已排批次再次付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "handoff", name: "在途接管", kind: "rss", config: { feedUrl: "https://handoff.example/feed" },
  } }); assert.equal(source.statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "handoff", title: "镜头检查", url: "https://handoff.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body, bodyStatus: "ok" });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  const boss = await getBoss(), [live] = await boss.fetch(topicAnalysisQueue.name); assert.ok(live);
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} }); assert.equal(submitted.statusCode, 200);
  const [batch] = await boss.fetch(topicAnalysisQueue.name); assert.ok(batch); assert.equal(batch.id, submitted.json().jobId);
  await assert.rejects(topicAnalysisQueue.run([batch.data] as never[]), QueueDeferred);
  assert.equal(provider.hits(), 0, "等原请求时不能发第二个请求");
  invalidNext = true;
  await assert.rejects(topicAnalysisQueue.run([live.data] as never[])); await boss.cancel(topicAnalysisQueue.name, live.id);
  assert.equal(provider.hits(), 1);
  await assert.rejects(topicAnalysisQueue.run([batch.data] as never[]), /采集中同版分析/);
  await boss.cancel(topicAnalysisQueue.name, batch.id);
  const state = (await app.inject({ url, headers })).json(); assert.equal(state.rows[0].state, "failed"); assert.equal(state.analyzed, 0);
  assert.equal(provider.hits(), 1);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queuedCount, 1);
  const [retry] = await boss.fetch(topicAnalysisQueue.name); assert.ok(retry);
  await topicAnalysisQueue.run([retry.data] as never[]); await boss.complete(topicAnalysisQueue.name, retry.id);
  assert.equal((await app.inject({ url, headers })).json().analyzed, 1); assert.equal(provider.hits(), 2);
});
