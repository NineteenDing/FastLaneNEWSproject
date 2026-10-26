import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only this isolated test's external HTTP model boundary.
const body = "星幕工坊（StageDesk）解决多镜头人物一致性。";
const entities = [{ kind: "tool", name: "星幕工坊", aliases: ["StageDesk"], quote: body }];
const requests: Array<{ messages: Array<{ content: string }> }> = [];
let beforeAnalysis: (() => Promise<void>) | undefined;
let invalidNext = false;
const provider = await stub(async (_hit, request) => {
  requests.push(JSON.parse(request.body));
  await beforeAnalysis?.();
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  if (invalidNext) { invalidNext = false; return { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }; }
  const extracted = input.material.body.includes("新镜工具（NewLens）") ? [...entities,
    { kind: "tool", name: "新镜工具", aliases: ["NewLens"], quote: "新镜工具（NewLens）可调整镜头。" }] : entities;
  return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
    summary: "人物一致性操作", reason: "可以展示制作步骤", viewerBenefit: "减少镜头返工", event: "制作步骤更新",
    evidenceQuotes: [body], entities: extracted, gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 80, demand: null, distinctiveness: 70 },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-cache-key", LLM_MODEL: "isolated-cache-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

async function runOne() {
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name);
  assert.ok(job, "分析任务应已持久排队");
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
}

test("采集中处理新材料，截止后同版分析和回执复用，不再付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") }); await resources.warm();
  config.modelCallsEnabled = true;
  const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "live-cache", name: "采集中分析来源", kind: "rss", config: { feedUrl: "https://live-cache.example/feed" },
  } }); assert.equal(source.statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "live-cache", title: "制作操作", url: "https://live-cache.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body, bodyStatus: "ok" });
  assert.equal(requests.length, 0, "入库事务本身不访问模型");
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  await runOne();
  const history = await app.inject({ url: "/api/admin/studio/history?q=StageDesk", headers });
  assert.equal(history.statusCode, 200); assert.deepEqual(history.json().rows.find((r: { id: string }) => r.id === "news:" + saved.articleId).entities, entities);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().rows.length, 0);
  assert.equal(requests.length, 1);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  await runOne();
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(analysis.analyzed, 1); assert.deepEqual(analysis.rows[0].entities, entities);
  assert.ok(analysis.rows[0].receiptId); assert.equal(requests.length, 1, "相同正文、规则和模型只付费一次");
});

test("采集中分析遵守暂停，读取不调模型，中断只显式恢复且复用原结果", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T10:00:00Z") }); await resources.warm();
  const saved = await upsertMaterial({ sourceId: "live-cache", title: "恢复分析", url: "https://live-cache.example/recovery", via: "import",
    discoveredAt: new Date("2026-10-19T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const url = `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, before = requests.length;
  config.modelCallsEnabled = false;
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
  assert.equal((await app.inject({ url })).statusCode, 401);
  const pending = await app.inject({ url, headers });
  assert.equal(pending.statusCode, 200); assert.equal(pending.json().state, "pending");
  assert.equal(pending.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence/news:missing/analysis", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence/not-a-material/analysis", headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 409);
  assert.equal(requests.length, before);
  config.modelCallsEnabled = true;
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await boss.cancel(topicAnalysisQueue.name, job.id);
  assert.equal((await app.inject({ url, headers })).json().state, "failed");
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0, "定时器不自动复活付费任务");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, true);
  await runOne();
  const complete = (await app.inject({ url, headers })).json();
  assert.equal(complete.state, "completed"); assert.deepEqual(complete.result.entities, entities);
  assert.equal(requests.length, before + 1);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, false);
  await app.inject({ url, headers }); assert.equal(requests.length, before + 1);
});

test("采集中正文更正有新待办，旧分析迟到不污染新索引，旧批次保持不变", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T11:00:00Z") }); await resources.warm();
  const input = { sourceId: "live-cache", title: "更正中的操作", url: "https://live-cache.example/corrected", via: "import",
    discoveredAt: new Date("2026-10-19T09:00:00Z"), bodyStatus: "ok" as const };
  const saved = await upsertMaterial({ ...input, bodyText: body });
  const url = `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, before = requests.length;
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  beforeAnalysis = async () => { await upsertMaterial({ ...input, bodyText: body + "新镜工具（NewLens）可调整镜头。" }); };
  try { await runOne(); } finally { beforeAnalysis = undefined; }
  const current = (await app.inject({ url, headers })).json();
  assert.equal(current.state, "pending"); assert.equal(current.result, null);
  const pendingIndex = (await app.inject({ url: "/api/admin/studio/history?q=NewLens", headers })).json().rows;
  assert.equal(pendingIndex.find((row: { id: string }) => row.id === "news:" + saved.articleId).entities, null);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await runOne();
  const complete = (await app.inject({ url, headers })).json();
  assert.equal(complete.state, "completed"); assert.equal(complete.result.entityIndex.indexed, true);
  assert.equal(complete.result.entities[1].name, "新镜工具"); assert.equal(requests.length, before + 2);
  const batches = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json();
  const original = (await app.inject({ url: `/api/admin/studio/topic-batches/${batches.rows[0].id}/materials`, headers })).json();
  assert.equal(original.total, 1); assert.equal(original.rows[0].body, body);
});

test("栏目规则变更使截止分析重新判断，保留旧批次规则与已付费缓存", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T12:00:00Z") }); await resources.warm();
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers,
    payload: { version: 1, questions: "优先检查能否稳定复现镜头和操作限制" } });
  assert.equal(changed.statusCode, 200);
  const before = requests.length;
  t.mock.timers.setTime(new Date("2026-10-20T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  const submitted = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  assert.equal(submitted.json().queuedCount, 2);
  await runOne(); await runOne();
  assert.equal(requests.length, before + 2);
  const input = JSON.parse(requests.at(-1)!.messages.at(-1)!.content);
  assert.equal(input.columns.find((column: { id: string }) => column.id === "practice").questions, "优先检查能否稳定复现镜头和操作限制");
  assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().analyzed, 2);
});

test("模型变更不错误复用旧服务结果，同版分析的重复读取仍零调用", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T10:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "live-cache", title: "模型配置切换", url: "https://live-cache.example/model", via: "import",
    discoveredAt: new Date("2026-10-21T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const before = requests.length;
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await runOne();
  process.env.LLM_BASE_URL = `${provider.url}/v2`; // A different effective service, while the model stays Flash.
  t.mock.timers.setTime(new Date("2026-10-22T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-20T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); await runOne();
  assert.equal(requests.length, before + 2);
  await app.inject({ url: prefix + "/analysis", headers }); await app.inject({ url: prefix + "/analysis", headers });
  assert.equal(requests.length, before + 2);
});

test("模型已付费而采集中结果回存失败，显式恢复用已完成缓存而不再付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T10:00:00Z") }); await resources.warm();
  const saved = await upsertMaterial({ sourceId: "live-cache", title: "回存恢复", url: "https://live-cache.example/save", via: "import",
    discoveredAt: new Date("2026-10-23T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const url = `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, before = requests.length;
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  await sql.unsafe(`CREATE FUNCTION reject_live_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'live-save-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_live BEFORE UPDATE ON studio_live_material_analyses FOR EACH ROW EXECUTE FUNCTION reject_live_save()");
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  try { await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /live-save-refused/); await boss.cancel(topicAnalysisQueue.name, job.id); }
  finally { await sql.unsafe("DROP TRIGGER reject_live ON studio_live_material_analyses"); await sql.unsafe("DROP FUNCTION reject_live_save()"); }
  assert.equal((await app.inject({ url, headers })).json().state, "failed"); assert.equal(requests.length, before + 1);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, true); await runOne();
  assert.equal((await app.inject({ url, headers })).json().state, "completed"); assert.equal(requests.length, before + 1);
});

test("博主视频先等可靠转写，媒体即时清理后提前分析，截止复用同版完整正文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T11:00:00Z") }); await resources.warm();
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    const following = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
    assert.equal(following.statusCode, 200); const creatorId = following.json().creator.id, boss = await getBoss();
    bilibiliFixture(transport, { description: "博主操作简介" });
    await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} });
    const [collect] = await boss.fetch(creatorQueue.name); assert.ok(collect);
    await creatorQueue.run([collect.data] as never[]); await boss.complete(creatorQueue.name, collect.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    const url = `/api/admin/studio/intelligence/creator:${post.id}/analysis`, before = requests.length;
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
    assert.equal((await app.inject({ url, headers })).json().state, "waiting_body"); assert.equal(requests.length, before);
    // Clock fixture only: PostgreSQL defaults use the real clock, independently of JS Date.
    await sql`UPDATE studio_creator_posts SET collected_at = '2026-10-23T09:00:00Z' WHERE id = ${post.id}`;
    transport.get("https://media.example").intercept({ path: "/cache-evidence.mp4" }).reply(200, Buffer.from("external-media-boundary-fixture"));
    const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/cache-evidence.mp4", kind: "audio" as const }),
      recognize: async () => ({ language: "zh", durationSeconds: 15, model: "external-asr-cache-fixture", segments: [{ start: 0, end: 15, text: body }] }) });
    assert.equal((await processor.process(post.id)).mediaCleaned, true);
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await runOne();
    const analysis = (await app.inject({ url, headers })).json(); assert.equal(analysis.result.entityIndex.indexed, true);
    const input = JSON.parse(requests.at(-1)!.messages.at(-1)!.content);
    assert.equal(input.material.body, "博主操作简介\n\n[本地转写]\n" + body);
    assert.equal(input.material.transcript.text, undefined); assert.equal(input.material.transcript.mediaState, undefined);
    t.mock.timers.setTime(new Date("2026-10-24T12:00:00Z").getTime()); await resources.warm();
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-22T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
    assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).json().queuedCount, 2);
    await runOne(); await runOne();
    assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().analyzed, 2);
    assert.equal(requests.length, before + 1, "视频与已有新闻都复用已完成分析"); transport.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await transport.close(); }
});

test("升级前已提实体的旧任务仍使用原请求与回执，不自动套用新缓存输入", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "live-cache", title: "升级前实体分析", url: "https://live-cache.example/legacy-entities", via: "import",
    discoveredAt: new Date("2026-10-25T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  const submitted = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); assert.equal(submitted.statusCode, 200);
  // Upgrade fixture: reproduce the persisted shape emitted by 0139, before cache_policy existed.
  await sql`UPDATE studio_topic_material_analyses SET cache_policy = NULL WHERE batch_id = ${frozen.json().batch.id}`;
  await sql`UPDATE pgboss.job SET data = data - 'cachePolicy' WHERE name = ${topicAnalysisQueue.name} AND id = ${submitted.json().jobId}`;
  await sql.unsafe(`CREATE FUNCTION reject_old_entity_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'old-entity-save-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_old_entity BEFORE UPDATE ON studio_topic_material_analyses FOR EACH ROW EXECUTE FUNCTION reject_old_entity_save()");
  const before = requests.length, boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  try { await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /old-entity-save-refused/); await boss.cancel(topicAnalysisQueue.name, job.id); }
  finally { await sql.unsafe("DROP TRIGGER reject_old_entity ON studio_topic_material_analyses"); await sql.unsafe("DROP FUNCTION reject_old_entity_save()"); }
  assert.equal(JSON.parse(requests.at(-1)!.messages.at(-1)!.content).analysisContext, undefined);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: { retryFailed: true } })).json().queued, true); await runOne();
  assert.equal(requests.length, before + 1); assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().analyzed, 1);
});

test("采中同上下文失败由截止批次接管，自动调度不再付费，只有显式恢复重试", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T10:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "live-cache", title: "失败接管", url: "https://live-cache.example/failed-handoff", via: "import",
    discoveredAt: new Date("2026-10-27T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1);
  const before = requests.length, boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  invalidNext = true;
  await assert.rejects(topicAnalysisQueue.run([job.data] as never[])); await boss.cancel(topicAnalysisQueue.name, job.id);
  assert.equal(requests.length, before + 1);
  t.mock.timers.setTime(new Date("2026-10-28T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-26T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: plan.version, startsAt: plan.startsAt, enabled: true } })).statusCode, 200);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0, "相同已失败付费请求不能被截止调度复活");
  const failed = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(failed.rows[0].state, "failed"); assert.ok(failed.rows[0].error); assert.equal(failed.analyzed, 0);
  assert.equal(requests.length, before + 1);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: { retryFailed: true } })).json().queuedCount, 1);
  await runOne(); assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().analyzed, 1);
  assert.equal(requests.length, before + 2);
});
