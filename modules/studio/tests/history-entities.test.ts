import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only controlled localhost provider fixtures in this test process.
const body = "星幕科技的林岚于2026-10-15发布星幕模型（StarStage）。星幕工坊（StageDesk）解决多镜头人物一致性。";
const entities = [
  { kind: "model", name: "星幕模型", aliases: ["StarStage"], quote: "发布星幕模型（StarStage）" },
  { kind: "tool", name: "星幕工坊", aliases: ["StageDesk"], quote: "星幕工坊（StageDesk）解决多镜头人物一致性。" },
  { kind: "company", name: "星幕科技", aliases: [], quote: "星幕科技的林岚" },
  { kind: "person", name: "林岚", aliases: [], quote: "星幕科技的林岚" },
  { kind: "task", name: "多镜头人物一致性", aliases: [], quote: "解决多镜头人物一致性" },
  { kind: "event", name: "发布星幕模型", aliases: [], quote: "于2026-10-15发布星幕模型（StarStage）" },
  { kind: "time", name: "2026-10-15", aliases: [], quote: "于2026-10-15发布" },
];
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let beforeAnalysis: (() => Promise<void>) | undefined;
const provider = await stub(async (_hit, request) => {
  requests.push(JSON.parse(request.body));
  const input = JSON.parse(requests.at(-1)!.messages.at(-1)!.content);
  if (!input.material) return { choices: [{ message: { content: JSON.stringify({ directions: [],
    assignments: input.materials.map((row: { material: { id: string } }) => ({ materialId: row.material.id, columnId: "practice", disposition: "not_topic", directionIds: [], reason: "先保留制作背景" })),
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
  await beforeAnalysis?.();
  const returnedEntities = input.material.title === "虚构名称测试" ? [{ ...entities[0]!, aliases: ["MadeUpAlias"] }] : entities;
  const requestedEntities = requests.at(-1)!.messages[0]!.content.includes("同时输出entities");
  return { id: "history-entities-response", choices: [{ message: { content: JSON.stringify({
    columnId: "practice", disposition: "support", summary: "镜头接续的制作条件", reason: "保留具体工作流及限制", viewerBenefit: "检查人物一致性", event: input.material.title === "流程变化" ? "短片编辑改进" : "制作更新",
    evidenceQuotes: ["星幕工坊（StageDesk）解决多镜头人物一致性。"], ...(requestedEntities ? { entities: returnedEntities } : {}),
    gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 80, demand: null, distinctiveness: 70 },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } };
});

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "history-entities-isolated-key", LLM_MODEL: "isolated-history-entities" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("原材料分析一次提取七类有依据名称，私有历史索引可读且不额外调用模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "entity-history", name: "结构化材料来源", kind: "rss", config: { feedUrl: "https://entity-history.example/feed" },
  } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "entity-history", title: "制作条件更新", url: "https://entity-history.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(analysis.analyzed, 1); assert.deepEqual(analysis.rows[0].entities, entities);
  assert.equal(analysis.rows[0].entityIndex.indexed, true);
  const read = await app.inject({ url: "/api/admin/studio/history?q=StarStage", headers });
  assert.equal(read.statusCode, 200); assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(read.json().rows[0].id, "news:" + saved.articleId); assert.deepEqual(read.json().rows[0].entities, entities);
  assert.equal(read.json().rows[0].body, undefined);
  assert.equal((await app.inject({ url: "/api/admin/studio/history?q=StarStage" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).json().queued, false);
  assert.equal(requests.length, 1); assert.ok(requests[0]!.messages[0]!.content.includes("entities"));
});

test("当期标题与事件词未提名称，综合仍按已提取名称召回旧背景而不遍历原文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "entity-history", title: "流程变化", url: "https://entity-history.example/two", via: "import",
    discoveredAt: new Date("2026-10-19T10:00:00Z"), publishedAt: new Date("2026-10-19T09:00:00Z"), bodyText: body + "现可追加片段。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} })).statusCode, 200);
  const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation);
  await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
  const input = JSON.parse(requests.at(-1)!.messages.at(-1)!.content);
  assert.equal(input.background.items.length, 1); assert.equal(input.background.items[0].material.title, "制作条件更新");
  assert.equal(input.background.items[0].material.body, body);
  assert.equal((await app.inject({ url: prefix, headers })).json().batch.materialCount, 1);
  assert.equal(requests.length, 3);
});


test("来源更正清除旧实体，旧冻结分析迟到仍保留但不能污染新索引", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") }); await resources.warm();
  const input = { sourceId: "entity-history", title: "等待分析时来源更正", url: "https://entity-history.example/corrected", via: "import",
    discoveredAt: new Date("2026-10-21T10:00:00Z"), publishedAt: new Date("2026-10-21T09:00:00Z"), bodyStatus: "ok" as const };
  const saved = await upsertMaterial({ ...input, bodyText: body });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-20T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  beforeAnalysis = async () => { await upsertMaterial({ ...input, bodyText: "CorrectedEntityOnly：旧版信息已撤回，暂不确认工具对应关系。" }); };
  try {
    const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  } finally { beforeAnalysis = undefined; }
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json().rows[0];
  assert.deepEqual(analysis.entities, entities); assert.equal(analysis.entityIndex.indexed, false);
  const read = (await app.inject({ url: "/api/admin/studio/history?q=CorrectedEntityOnly", headers })).json().rows;
  assert.equal(read.length, 1); assert.equal(read[0].id, "news:" + saved.articleId);
  assert.equal(read[0].contentVersion.revision, 2); assert.equal(read[0].entities, null);
  const old = (await app.inject({ url: "/api/admin/studio/history?q=StarStage", headers })).json().rows;
  assert.ok(!old.some((row: { id: string }) => row.id === "news:" + saved.articleId));
  assert.equal((await app.inject({ url: prefix + "/materials", headers })).json().rows[0].body, body);
  const first = (await app.inject({ url: "/api/admin/studio/history?q=StarStage", headers })).json().rows.find((row: { title: string }) => row.title === "制作条件更新");
  assert.deepEqual(first.entities, entities);
  await upsertMaterial({ sourceId: "entity-history", title: "制作条件更新", url: "https://entity-history.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "AfterCompletedCorrection：此前命名现已更正。", bodyStatus: "ok" });
  const corrected = (await app.inject({ url: "/api/admin/studio/history?q=AfterCompletedCorrection", headers })).json().rows[0];
  assert.equal(corrected.entities, null);
});

test("模型虚构别名不能进入完成分析或私有历史索引", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T12:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "entity-history", title: "虚构名称测试", url: "https://entity-history.example/invalid", via: "import",
    discoveredAt: new Date("2026-10-23T10:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-22T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /实体名称、别名与引文必须有原文依据/); await boss.cancel(topicAnalysisQueue.name, job.id);
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(analysis.rows[0].state, "failed"); assert.equal(analysis.analyzed, 0); assert.equal(analysis.rows[0].entities, undefined);
  assert.equal((await app.inject({ url: "/api/admin/studio/history?q=MadeUpAlias", headers })).json().rows.length, 0);
});

test("旧任务取得模型回执后写入失败，显式重试仍用旧输入并复用已付款结果", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "entity-history", title: "旧请求恢复", url: "https://entity-history.example/legacy", via: "import",
    discoveredAt: new Date("2026-10-25T10:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  const submitted = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); assert.equal(submitted.statusCode, 200);
  // Upgrade fixture only: reproduce the persisted shape produced before 0139. Verification below uses public flows.
  await sql`UPDATE studio_topic_material_analyses SET entity_policy = NULL WHERE batch_id = ${frozen.json().batch.id}`;
  await sql`UPDATE pgboss.job SET data = data - 'entityPolicy' WHERE name = ${topicAnalysisQueue.name} AND id = ${submitted.json().jobId}`;
  await sql.unsafe(`CREATE FUNCTION reject_entity_legacy_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'legacy-entity-write-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_entity_legacy BEFORE UPDATE ON studio_topic_material_analyses FOR EACH ROW EXECUTE FUNCTION reject_entity_legacy_save()");
  try {
    const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /legacy-entity-write-refused/); await boss.cancel(topicAnalysisQueue.name, job.id);
  } finally {
    await sql.unsafe("DROP TRIGGER reject_entity_legacy ON studio_topic_material_analyses"); await sql.unsafe("DROP FUNCTION reject_entity_legacy_save()");
  }
  const count = requests.length;
  assert.ok(!requests.at(-1)!.messages[0]!.content.includes("同时输出entities"));
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: { retryFailed: true } })).json().queued, true);
  const [retry] = await boss.fetch(topicAnalysisQueue.name); assert.ok(retry);
  await topicAnalysisQueue.run([retry.data] as never[]); await boss.complete(topicAnalysisQueue.name, retry.id);
  assert.equal(requests.length, count);
  const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json();
  assert.equal(analysis.analyzed, 1); assert.equal(analysis.rows[0].entities, undefined); assert.equal(analysis.rows[0].entityIndex, undefined);
});


test("博主视频转写清理后仍能按同版正文保存结构化名称，索引不误判版本失配", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T12:00:00Z") }); await resources.warm();
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    const following = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
    assert.equal(following.statusCode, 200); const creatorId = following.json().creator.id, boss = await getBoss();
    bilibiliFixture(transport, { description: "历史视频简介" });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    const [collect] = await boss.fetch(creatorQueue.name); assert.ok(collect);
    await creatorQueue.run([collect.data] as never[]); await boss.complete(creatorQueue.name, collect.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    transport.get("https://media.example").intercept({ path: "/entity-evidence.mp4" }).reply(200, Buffer.from("external-media-boundary-fixture"));
    const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/entity-evidence.mp4", kind: "audio" as const }),
      recognize: async () => ({ language: "zh", durationSeconds: 15, model: "external-asr-entity-fixture", segments: [{ start: 0, end: 15, text: body }] }) });
    await processor.process(post.id);
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-26T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 1);
    const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, count = requests.length;
    await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
    const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
    const analysis = (await app.inject({ url: prefix + "/analysis", headers })).json().rows[0];
    assert.equal(analysis.entityIndex.indexed, true); assert.deepEqual(analysis.entities, entities);
    const indexed = (await app.inject({ url: "/api/admin/studio/history?q=StarStage", headers })).json().rows.find((row: { id: string }) => row.id === "creator:" + post.id);
    assert.ok(indexed); assert.deepEqual(indexed.entities, entities);
    const evidence = (await app.inject({ url: prefix + "/materials", headers })).json().rows[0];
    assert.equal(evidence.transcript.mediaState, "cleaned"); assert.equal(evidence.body, "历史视频简介\n\n[本地转写]\n" + body);
    assert.equal(requests.length, count + 1); transport.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await transport.close(); }
});
