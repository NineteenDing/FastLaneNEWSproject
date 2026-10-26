import { openTopicProcessing } from "./topic-processing-navigation.ts";
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
import { topicReviewQueue } from "../backend/topic-review.ts";
import { randomUUID } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit local model fixture, never a production default.
const requests: Array<Record<string, any>> = [];
const currentBody = "可灵角色参考需要先固定角色图，再逐镜检查。";
const adoptedQuote = "旧版参考条件需要逐镜核对，不能将新版本的能力套回旧项目。";
const oldBody = "可灵旧版只支持固定视角。\n\n先对照旧版限制，再检查新功能的适用条件。\n\n第三段为原始说明。\n\n" + "原始长段。".repeat(130) + adoptedQuote;
let citeHistory = false;
let quotedHistoryBody = oldBody, quotedHistoryQuote = adoptedQuote;
let lastPrefix = "", lastDraftId = "", legacyPrefix = "", videoDraftId = "";
const provider = await stub((_hit, request) => {
  const payload = JSON.parse(request.body), input = JSON.parse(payload.messages.at(-1).content); requests.push(input);
  const result = input.task === "review_packet" ? { checkedParts: input.parts.map((part: any) => part.id), opinions: [] }
    : input.task === "review_summary" ? { passed: true, opinionIds: [], summary: "保留原始条件并标明新旧资料" }
    : input.material ? { columnId: "practice", disposition: "support", summary: "可灵参考图的更新", reason: "有制作流程",
    viewerBenefit: "减少角色漂移", event: "可灵角色参考", evidenceQuotes: [currentBody], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } }
    : { directions: [{ id: "reference", columnId: "practice", eventKey: "kling-reference", question: "可灵角色参考如何使用？", viewerBenefit: "检查适用条件",
      whyNow: "角色参考有变化", angle: "对照限制讲操作", usage: { steps: ["固定角色图", "逐镜检查"], conditions: ["已有参考图"], limitations: ["没有本人实测"] },
      titles: ["可灵角色参考先检查条件", "角色参考怎么用", "连续镜头的参考图流程"], preferredTitle: 0,
      structure: { opening: "提出制作问题", rhythm: "先条件再演示", ending: "给出下一步" },
      references: [...input.materials.map((row: any) => ({ materialId: row.material.id, role: "fact", quote: currentBody, reason: "当前制作依据" })),
        ...(citeHistory ? input.background.items.filter((item: any) => item.material.body === quotedHistoryBody).slice(0, 1).map((item: any) => ({ materialId: item.material.id, role: "counterpoint", quote: quotedHistoryQuote, reason: "明确过去的条件，避免把新旧能力混淆" })) : [])],
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
    }], assignments: input.materials.map((row: any) => ({ materialId: row.material.id, columnId: "practice", disposition: "support", directionIds: ["reference"], reason: "本期制作依据" })) };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
});

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "history-topic-test-key", LLM_MODEL: "history-topic-test" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("选题生成自动按索引读取旧背景及版本出处，历史不增加本期材料数，刷新不触发分析", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "topic-history", name: "制作原始资料", kind: "rss", config: { feedUrl: "https://topic-history.example/feed" } } })).statusCode, 200);
  const old = await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考旧版条件", url: "https://topic-history.example/old", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), publishedAt: new Date("2026-10-09T10:00:00Z"), bodyText: oldBody, bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "topic-history", title: "完全无关的天气情况", url: "https://topic-history.example/weather", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), bodyText: "晴天", bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考新版", url: "https://topic-history.example/current", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 1);
  const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} })).statusCode, 200);
  const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation);
  await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
  const input = requests.at(-1)!; assert.equal(input.background?.items.length, 1);
  const background = input.background.items[0]; assert.equal(background.material.id, "news:" + old.articleId);
  assert.equal(background.material.body, oldBody); assert.equal(new Date(background.material.publishedAt).toISOString(), "2026-10-09T10:00:00.000Z");
  assert.equal(background.material.contentVersion.revision, 1); assert.equal(background.material.source.name, "制作原始资料");
  assert.ok(background.reason); assert.ok(background.anchors.length > 0);
  const before = requests.length;
  const read = await app.inject({ url: prefix + "/history", headers }); assert.equal(read.statusCode, 200);
  assert.equal(read.headers["cache-control"], "no-store"); assert.equal(read.json().items.length, 1);
  assert.equal((await app.inject({ url: prefix + "/history" })).statusCode, 401);
  assert.equal((await app.inject({ url: prefix, headers })).json().batch.materialCount, 1);
  await app.inject({ url: prefix + "/recommendations", headers }); assert.equal(requests.length, before);
});

test("历史原文能被方向引用，独立二审检查同版背景，采纳后稿件继续保留这份证据", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") }); await resources.warm(); citeHistory = true;
  await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考跨版本检查", url: "https://topic-history.example/current-two", via: "import",
    discoveredAt: new Date("2026-10-19T10:00:00Z"), publishedAt: new Date("2026-10-19T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id, prefix = `/api/admin/studio/topic-batches/${batchId}`;
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const boss = await getBoss(), [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
  const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation);
  await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
  const background = requests.at(-1)!.background.items.find((item: any) => item.material.body === oldBody).material;
  const generated = (await app.inject({ url: prefix + "/recommendations", headers })).json();
  assert.equal(generated.result.assignments.length, 1);
  assert.ok(generated.referenceMaterials.some((item: any) => item.id === background.id));
  assert.equal((await app.inject({ method: "POST", url: prefix + "/review", headers, payload: {} })).statusCode, 200);
  const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review);
  await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
  const packets = requests.filter(input => input.task === "review_packet");
  assert.ok(packets.some(input => input.backgroundIds.includes(background.id)));
  const backgroundParts = packets.flatMap(input => input.parts).filter((part: any) => part.materialId === background.id).sort((a: any, b: any) => a.part - b.part);
  assert.equal(JSON.parse(backgroundParts.map((part: any) => part.content).join("")).body, oldBody);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200);
  const draft = (await app.inject({ url: `/api/admin/studio/drafts/${created.json().id}`, headers })).json();
  assert.equal(draft.snapshot.materials.find((item: any) => item.id === background.id).body, background.body);
  assert.equal(draft.snapshot.materials.length, 2);
  const anchors = draft.snapshot.history.items.find((item: any) => item.materialId === background.id).anchors;
  assert.equal(anchors.length, 1); assert.equal(anchors[0].kind, "text");
  assert.equal(anchors[0].paragraph, 4); assert.ok(anchors[0].start > 600);
  assert.equal(anchors[0].quote, adoptedQuote); assert.equal(oldBody.slice(anchors[0].start, anchors[0].end), adoptedQuote);
  lastPrefix = prefix; lastDraftId = created.json().id;
});

test("历史原文更正使关联显示失效提示，旧选题和旧稿保留原证据，不在读取时重新生成", async () => {
  const history = (await app.inject({ url: lastPrefix + "/history", headers })).json(), chosen = history.items[0].material;
  const beforeDraft = (await app.inject({ url: `/api/admin/studio/drafts/${lastDraftId}`, headers })).json(), calls = requests.length;
  const changed = await upsertMaterial({ sourceId: "topic-history", title: chosen.title, url: chosen.url, via: "import",
    discoveredAt: new Date(chosen.collectedAt), publishedAt: new Date(chosen.publishedAt), bodyText: "CorrectionOnlyMarker：原限制有更正，当前条件需要重新核实。", bodyStatus: "ok" });
  assert.equal("news:" + changed.articleId, chosen.id);
  const current = (await app.inject({ url: lastPrefix + "/history", headers })).json();
  assert.deepEqual(current.items, history.items); assert.ok(current.changedMaterialIds.includes(chosen.id));
  const draft = (await app.inject({ url: `/api/admin/studio/drafts/${lastDraftId}`, headers })).json();
  assert.deepEqual(draft.snapshot, beforeDraft.snapshot);
  assert.ok(draft.historyChanges?.changedMaterialIds.includes(chosen.id));
  assert.equal(requests.length, calls);
});

test("历史候选最多50份且只读取10份背景，迟到但已属于本期的材料不重复成为背景", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") }); await resources.warm(); citeHistory = false;
  for (let index = 0; index < 55; index++) await upsertMaterial({ sourceId: "topic-history", title: `BoundSignalToken 可灵角色参考旧资料 ${index}`,
    url: `https://topic-history.example/bounded-${index}`, via: "import", discoveredAt: new Date("2026-10-01T10:00:00Z"),
    publishedAt: new Date("2026-10-01T09:00:00Z"), bodyText: "原始条件必须标明旧版。", bodyStatus: "ok" });
  const late = await upsertMaterial({ sourceId: "topic-history", title: "BoundSignalToken LateMarkerToken 可灵角色参考迟到资料", url: "https://topic-history.example/late",
    via: "import", discoveredAt: new Date("2026-10-19T10:00:00Z"), publishedAt: new Date("2026-10-19T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "topic-history", title: "BoundSignalToken LateMarkerToken 可灵角色参考当期", url: "https://topic-history.example/bounded-current",
    via: "import", discoveredAt: new Date("2026-10-21T10:00:00Z"), publishedAt: new Date("2026-10-21T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-20T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 2);
  const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  const submitted = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); assert.equal(submitted.json().queuedCount, 2);
  for (let index = 0; index < 2; index++) { const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
  const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const history = (await app.inject({ url: prefix + "/history", headers })).json();
  assert.equal(history.candidateCount, 50); assert.equal(history.items.length, 10);
  assert.ok(!history.items.some((item: any) => item.material.id === "news:" + late.articleId));
  assert.equal((await app.inject({ url: prefix, headers })).json().batch.materialCount, 2);
});

test("升级前无背景记录的在途任务保持原输入，原结果写入失败后重试复用付费回执", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T12:00:00Z") }); await resources.warm(); citeHistory = false;
  await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考旧任务恢复", url: "https://topic-history.example/legacy-task", via: "import",
    discoveredAt: new Date("2026-10-23T10:00:00Z"), publishedAt: new Date("2026-10-23T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-22T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id, prefix = `/api/admin/studio/topic-batches/${batchId}`;
  const boss = await getBoss(); await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
  // Database restore seam: reproduce the pre-0137 backup shape without a history marker.
  await sql`DELETE FROM studio_topic_history WHERE batch_id = ${batchId}`;
  await sql.unsafe(`CREATE FUNCTION test_reject_legacy_topic() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'draft' THEN RAISE EXCEPTION 'legacy-topic-save-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER test_legacy_topic BEFORE UPDATE ON studio_topic_recommendations FOR EACH ROW EXECUTE FUNCTION test_reject_legacy_topic()");
  try {
    const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
    await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /legacy-topic-save-refused/);
    await boss.cancel(topicGenerationQueue.name, job.id);
  } finally {
    await sql.unsafe("DROP TRIGGER test_legacy_topic ON studio_topic_recommendations"); await sql.unsafe("DROP FUNCTION test_reject_legacy_topic()");
  }
  const calls = requests.length; assert.equal(requests.at(-1)!.background, undefined);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: { retryFailed: true } })).json().queued, true);
  const [retry] = await boss.fetch(topicGenerationQueue.name); assert.ok(retry);
  await topicGenerationQueue.run([retry.data] as never[]); await boss.complete(topicGenerationQueue.name, retry.id);
  assert.equal(requests.length, calls); assert.equal((await app.inject({ url: prefix + "/recommendations", headers })).json().state, "draft");
  assert.equal((await app.inject({ url: prefix + "/history", headers })).json().state, "not_prepared");
  legacyPrefix = prefix;
});

test("新背景快照初次准备和数据库读回后的输入一致，保存故障重试不再次支付生成请求", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") }); await resources.warm();
  await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考新任务恢复", url: "https://topic-history.example/new-receipt-task", via: "import",
    discoveredAt: new Date("2026-10-25T10:00:00Z"), publishedAt: new Date("2026-10-25T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
  await sql.unsafe(`CREATE FUNCTION test_reject_new_topic() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'draft' THEN RAISE EXCEPTION 'new-topic-save-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER test_new_topic BEFORE UPDATE ON studio_topic_recommendations FOR EACH ROW EXECUTE FUNCTION test_reject_new_topic()");
  try {
    const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
    await assert.rejects(topicGenerationQueue.run([job.data] as never[]), /new-topic-save-refused/); await boss.cancel(topicGenerationQueue.name, job.id);
  } finally { await sql.unsafe("DROP TRIGGER test_new_topic ON studio_topic_recommendations"); await sql.unsafe("DROP FUNCTION test_reject_new_topic()"); }
  const calls = requests.length; assert.ok(requests.at(-1)!.background.items.length > 0);
  await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: { retryFailed: true } });
  const [retry] = await boss.fetch(topicGenerationQueue.name); assert.ok(retry);
  await topicGenerationQueue.run([retry.data] as never[]); await boss.complete(topicGenerationQueue.name, retry.id);
  assert.equal(requests.length, calls, "相同冻结背景不能因为数据库JSON字段顺序改变而生成新付费请求");
});

test("采纳历史视频后续跨分段引文，稿件保存对应原转写30至50秒而非开头样本", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-10T12:00:00Z") }); await resources.warm();
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    const following = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
    assert.equal(following.statusCode, 200); const creatorId = following.json().creator.id, boss = await getBoss();
    bilibiliFixture(transport, { description: "历史视频简介" });
    await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} });
    const [collect] = await boss.fetch(creatorQueue.name); assert.ok(collect);
    await creatorQueue.run([collect.data] as never[]); await boss.complete(creatorQueue.name, collect.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    transport.get("https://media.example").intercept({ path: "/history-anchor.mp4" }).reply(200, Buffer.from("historical-video-boundary-fixture"));
    const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/history-anchor.mp4", kind: "audio" as const }),
      recognize: async () => ({ language: "zh", durationSeconds: 50, model: "external-asr-history-fixture", segments: [
        { start: 0, end: 10, text: "首先准备原始素材。" }, { start: 10, end: 20, text: "再固定角色图。" }, { start: 20, end: 30, text: "列出镜头检查条件。" },
        { start: 30, end: 40, text: "后续镜头要核对人物位置。" }, { start: 40, end: 50, text: "旧项目不能直接套用新参数。" },
      ] }) });
    await processor.process(post.id);
    quotedHistoryBody = "历史视频简介\n\n[本地转写]\n首先准备原始素材。\n再固定角色图。\n列出镜头检查条件。\n后续镜头要核对人物位置。\n旧项目不能直接套用新参数。";
    quotedHistoryQuote = "要核对人物位置。\n旧项目不能直接套用"; citeHistory = true;
    t.mock.timers.setTime(new Date("2026-10-28T12:00:00Z").getTime()); await resources.warm();
    await upsertMaterial({ sourceId: "topic-history", title: "角色一致性的方法：可灵角色参考新版", url: "https://topic-history.example/video-anchor-current", via: "import",
      discoveredAt: new Date("2026-10-27T10:00:00Z"), publishedAt: new Date("2026-10-27T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
    // PostgreSQL stamps real collection time. First close the pending window so the collected video becomes past evidence.
    const prior = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-26T12:00:00Z" } });
    assert.equal(prior.statusCode, 200); assert.equal(prior.json().batch.materialCount, 2);
    t.mock.timers.setTime(new Date("2026-10-30T12:00:00Z").getTime()); await resources.warm();
    await upsertMaterial({ sourceId: "topic-history", title: "历史视频简介：角色一致性的方法", url: "https://topic-history.example/video-anchor-next", via: "import",
      discoveredAt: new Date("2026-10-29T10:00:00Z"), publishedAt: new Date("2026-10-29T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-28T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 1);
    const batchId = frozen.json().batch.id, prefix = `/api/admin/studio/topic-batches/${batchId}`;
    await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
    const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
    await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
    await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} });
    const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation);
    await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
    const historicalVideo = requests.at(-1)!.background.items.find((item: any) => item.material.id === "creator:" + post.id);
    assert.ok(historicalVideo, "已收录的视频应按其标题/简介被历史索引召回");
    assert.equal(historicalVideo.material.body, quotedHistoryBody);
    await app.inject({ method: "POST", url: prefix + "/review", headers, payload: {} });
    const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review);
    await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId, directionIds: ["reference"] } });
    assert.equal(created.statusCode, 200);
    const draft = (await app.inject({ url: `/api/admin/studio/drafts/${created.json().id}`, headers })).json();
    assert.deepEqual(draft.snapshot.history.items.find((item: any) => item.materialId === "creator:" + post.id).anchors,
      [{ kind: "video", startSeconds: 30, endSeconds: 50, quote: "要核对人物位置。\n旧项目不能直接套用" }]);
    assert.equal(draft.snapshot.materials.find((item: any) => item.id === "creator:" + post.id).transcript.mediaState, "cleaned");
    videoDraftId = created.json().id;
    transport.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await transport.close(); }
});

test("网页按需读取背景和局部重试，显示旧版本更正与实际引文，阅读不调用模型或覆盖独立稿件", async () => {
  const { chromium, expect } = await import("@playwright/test"), { createServer, request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { listenHttpForFetch } = await import("../../../tests/http-listener.ts");
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const calls = requests.length;
  let reads = 0; page.on("request", request => { if (/\/topic-batches\/[^/]+\/history$/.test(request.url())) reads++; });
  const capture = async (name: string, width: number) => {
    await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: `.impeccable/review/history-background-${name}.png`, fullPage: true });
  };
  try {
    const batchUrl = web.origin + lastPrefix.replace("/api/admin/studio/topic-batches/", "/admin/studio/topics/batches/");
    await page.goto(batchUrl); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    const panel = page.getByRole("group", { name: "历史背景关联", exact: true });
    await expect(panel).toBeVisible(); await expect(panel).not.toHaveAttribute("open", ""); assert.equal(reads, 0);
    await page.route("**/api/admin/studio/topic-batches/*/history", route => route.fulfill({ status: 503, body: "unavailable" }));
    await panel.locator(":scope > summary").click(); await expect(panel.getByRole("alert")).toContainText("背景资料暂时无法读取");
    await expect(page.getByRole("region", { name: "批次概览", exact: true })).toContainText("选题审核通过");
    await capture("error-mobile", 390);
    await page.unroute("**/api/admin/studio/topic-batches/*/history"); await panel.getByRole("button", { name: "重试背景加载", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0); await expect(panel).toContainText("条背景来源已变化");
    await expect(panel).toContainText("历史索引尚未完成存量补建"); await expect(panel).toContainText("原始发布：2026年10月9日");
    const old = panel.locator("details.studio-batch-material").filter({ hasText: "可灵角色参考旧版条件" });
    await expect(old).not.toHaveAttribute("open", ""); await old.locator(":scope > summary").click();
    await expect(old).toContainText(adoptedQuote); await expect(old).not.toContainText("CorrectionOnlyMarker");
    await expect(old.getByRole("link", { name: "另页核对当前情报", exact: true })).toHaveAttribute("target", "_blank");
    await capture("topics-desktop", 1440); await capture("topics-mobile", 390);
    await page.goto(web.origin + `/admin/studio/writing/${lastDraftId}`);
    await page.getByRole("button", { name: "写作依据", exact: true }).click();
    await expect(page.getByText(/条背景来源已变化或不再可检索/)).toBeVisible();
    await page.getByRole("dialog", { name: "写作依据与版本", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    const source = page.getByRole("region", { name: "本稿全部引用", exact: true }).getByRole("listitem").filter({ has: page.getByRole("button", { name: "可灵角色参考旧版条件", exact: true }) });
    await source.getByText("历史关联依据", { exact: true }).click();
    const citation = source.getByRole("group", { name: "采用的历史引文位置", exact: true });
    await citation.locator(":scope > summary").click(); await expect(citation).toContainText("原文第 4 段"); await expect(citation).toContainText(adoptedQuote);
    const editor = page.locator(".tiptap"); await editor.click(); await editor.fill("这篇稿件保留自己的手动修改，查看历史引用不会改写正文。");
    await page.getByRole("button", { name: "保存", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: /已保存.*版本 2/ })).toBeVisible();
    await capture("writing-desktop", 1440); await capture("writing-mobile", 390);
    await expect(editor).toHaveText("这篇稿件保留自己的手动修改，查看历史引用不会改写正文。");
    await page.goto(web.origin + `/admin/studio/writing/${videoDraftId}`);
    const video = page.getByRole("region", { name: "本稿全部引用", exact: true }).getByRole("listitem").filter({ has: page.getByRole("button", { name: "角色一致性的方法", exact: true }) });
    await video.getByText("历史关联依据", { exact: true }).click(); await video.getByRole("group", { name: "采用的历史引文位置", exact: true }).locator(":scope > summary").click();
    await expect(video).toContainText("原转写 30–50 秒"); await expect(page.locator(".tiptap")).toHaveText("");
    await page.goto(web.origin + legacyPrefix.replace("/api/admin/studio/topic-batches/", "/admin/studio/topics/batches/"));
    await openTopicProcessing(page);
    const legacy = page.getByRole("group", { name: "历史背景关联", exact: true }); await legacy.locator(":scope > summary").click();
    await expect(legacy).toContainText("本批次尚无历史关联记录"); await expect(legacy).not.toContainText("没有召回相关背景");
    assert.equal(requests.length, calls, "背景读取、重试、稿件保存及引用阅读不调用模型");
  } finally { await browser.close(); await web.stop(); }
});

test("历史数量设置在提交综合时冻结，后来修改设置不改变排队任务和旧批次", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:00:00Z") }); await resources.warm(); citeHistory = false;
  const settingsUrl = "/api/admin/studio/history-settings";
  const saved = await app.inject({ method: "PUT", url: settingsUrl, headers, payload: { version: 0, candidateLimit: 7, evidenceLimit: 2 } });
  assert.equal(saved.statusCode, 200);
  await upsertMaterial({ sourceId: "topic-history", title: "可灵角色参考数量配置", url: "https://topic-history.example/config-current", via: "import",
    discoveredAt: new Date("2026-10-31T10:00:00Z"), publishedAt: new Date("2026-10-31T09:00:00Z"), bodyText: currentBody, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-30T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} });
  const [analysis] = await boss.fetch(topicAnalysisQueue.name); assert.ok(analysis);
  await topicAnalysisQueue.run([analysis.data] as never[]); await boss.complete(topicAnalysisQueue.name, analysis.id);
  assert.equal((await app.inject({ method: "POST", url: prefix + "/recommendations", headers, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: settingsUrl, headers, payload: { version: 1, candidateLimit: 50, evidenceLimit: 10 } })).statusCode, 200);
  const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
  await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const history = (await app.inject({ url: prefix + "/history", headers })).json();
  assert.equal(history.candidateLimit, 7); assert.equal(history.candidateCount, 7); assert.equal(history.evidenceLimit, 2); assert.equal(history.items.length, 2);
  assert.equal((await app.inject({ url: lastPrefix + "/history", headers })).json().evidenceLimit, 10);
  assert.deepEqual((await app.inject({ url: settingsUrl, headers })).json(), { version: 2, candidateLimit: 50, evidenceLimit: 10 });
});
