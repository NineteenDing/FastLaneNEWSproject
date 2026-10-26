import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { saveCreatorContent } from "../backend/creator-content.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const body = "星幕StageDesk发布角色参考功能，只支持单人镜头。";
const entities = [{ kind: "tool", name: "StageDesk", aliases: [], quote: body }];
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect();
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
let calls = 0;
let important = false;
let reuseEvent = false;
let memeMode: "important_ai" | "unrelated" | null = null;
let eventIdentitySuffix = "";
let foundationMaterialId = "";
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++;
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content), quote = input.material.body;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: "角色参考功能与单人镜头限制", reason: "提供明确功能及限制", viewerBenefit: "检查角色参考的适用镜头",
    event: "StageDesk角色参考功能发布", evidenceQuotes: [quote], entities: important ? [] : entities,
    gates: { audience: !important, evidence: true, benefit: !important },
    dimensions: { audience: 90, practical: 80, evidence: 90, freshness: 80, demand: null, distinctiveness: 60 },
    ...(important ? { titleZh:"通用模型发布的中文标题", shared: {
      titleZh: null,
      scope: memeMode ?? "important_ai", scopeReason: "通用模型发布会影响后续创作工具能力，暂不宣称已适配影视", scopeQuotes: [quote],
      facts: [{ text: "通用模型正式发布", quotes: [quote] }],
      publicDimensions: { practical: { value: 10, reason: "尚无直接工作流" }, interest: { value: 80, reason: "重大能力变化" }, substance: { value: 85, reason: "有明确发布事实" } },
      columnMatches: [{ columnId: "news", value: 90, reason: "需分析后续产业影响" }],
      event: { relation: reuseEvent && input.eventCandidates?.length ? "same" : "new", candidateId: reuseEvent ? input.eventCandidates?.[0]?.id ?? null : null,
        label: "星幕通用模型V2发布", identity: (memeMode ? "具体模仿案例:" + memeMode : reuseEvent ? "另一种措辞的星幕V2发布报道" : "星幕|V2|正式发布|2026-10-18") + eventIdentitySuffix, quotes: [quote] },
      reportingKind: "original", memeEvidence: memeMode ? [{ text: "正文列明多个实际模仿案例", quotes: [quote] }] : [],
    } } : {}),
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

async function drain() {
  const boss = await getBoss();
  for (;;) {
    const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) return;
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  }
}

test("不同新闻出处的相同完整内容共享一次分析，分别保留来源、实体和回执，截止不重复付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") });
  await resources.warm(); config.modelCallsEnabled = true;
  const connection = await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers,
    payload: { version: 0, baseUrl: "https://api.deepseek.com/v1", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash", apiKey: "private-shared-fixture-key" } });
  assert.equal(connection.statusCode, 200, connection.body);
  const ids: string[] = [];
  for (const source of ["shared-first", "shared-second"]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
      id: source, name: source, kind: "rss", config: { feedUrl: `https://${source}.example/feed` },
    } })).statusCode, 200);
    const saved = await upsertMaterial({ sourceId: source, title: "StageDesk角色参考功能发布", url: `https://${source}.example/one`, via: "import",
      discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body, bodyStatus: "ok" });
    ids.push("news:" + saved.articleId);
  }
  assert.equal(calls, 0);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2); await drain();
  assert.equal(calls, 1, "相同内容不能因来源、URL或材料ID不同而重复理解");
  const readings = await Promise.all(ids.map(id => app.inject({ url: `/api/admin/studio/intelligence/${id}`, headers })));
  assert.notEqual(readings[0]!.json().source.id, readings[1]!.json().source.id);
  assert.equal(readings[0]!.json().analysis.receiptId, readings[1]!.json().analysis.receiptId);
  const history = (await app.inject({ url: "/api/admin/studio/history?q=StageDesk", headers })).json();
  for (const id of ids) assert.deepEqual(history.rows.find((row: { id: string }) => row.id === id).entities, entities);
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime()); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queuedCount, 2); await drain();
  assert.equal((await app.inject({ url, headers })).json().analyzed, 2); assert.equal(calls, 1);
});

test("重要通用AI变化保存共享事实、栏目匹配及公共语义评分，不因缺少直接操作教程而排除", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T10:00:00Z") }); await resources.warm();
  important = true;
  try {
    const saved = await upsertMaterial({ sourceId: "shared-first", title: "星幕通用模型V2正式发布", url: "https://shared-first.example/foundation-v2", via: "import",
      discoveredAt: new Date("2026-10-19T09:00:00Z"), publishedAt: new Date("2026-10-18T08:00:00Z"),
      bodyText: "2026年10月18日，星幕正式发布通用模型V2，尚无影视工具适配记录。", bodyStatus: "ok" });
    foundationMaterialId = "news:" + saved.articleId;
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await drain();
    const url = `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`;
    const reading = await app.inject({ url, headers }); assert.equal(reading.statusCode, 200);
    const result = reading.json().result;
    assert.equal(result.shared.scope, "important_ai"); assert.equal(result.shared.facts.length, 1);
    assert.equal(result.shared.columnMatches[0].columnId, "news");
    assert.equal(result.shared.publicDimensions.practical.value, 10);
    assert.equal(result.score.eligible, true, "重大AI变化可进入内部候选，不要求已经有实操教程");
    const before = calls; await app.inject({ url, headers }); assert.equal(calls, before);
  } finally { important = false; }
});

test("同一事件的十个独立报道主体触发出圈，机构多账号和重复抓取不刷数，读取不调用模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T11:00:00Z") }); await resources.warm(); important = true;
  try {
    const ids: string[] = [];
    const quote = "2026年10月18日，星幕正式发布通用模型V2，尚无影视工具适配记录。";
    for (let i = 0; i < 10; i++) {
      const sourceId = "event-reporter-" + i;
      assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
        id: sourceId, name: sourceId, kind: "rss", config: { feedUrl: `https://${sourceId}.example/feed` },
      } })).statusCode, 200);
      const saved = await upsertMaterial({ sourceId, title: "星幕通用模型V2正式发布", url: `https://${sourceId}.example/one`, via: "import",
        discoveredAt: new Date("2026-10-19T09:30:00Z"), publishedAt: new Date("2026-10-19T07:00:00Z"), bodyText: quote, bodyStatus: "ok" });
      ids.push("news:" + saved.articleId);
    }
    await scheduleTopicMaterialAnalyses(); await drain();
    const url = `/api/admin/studio/intelligence/${ids[0]}/event`, before = calls;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200, response.body);
    const event = response.json();
    assert.equal(event.propagation.independentReporters, 11); // 十个新增主体，加上上一测试的原始报道。
    assert.equal(event.propagation.independentOriginalReporters, 1, "相同正文的转载不能变成十一份独立原始验证");
    assert.equal(event.breakout.triggered, true); assert.ok(event.breakout.reasons.includes("independent_reports"));
    const source = (await app.inject({ url: "/api/admin/sources/event-reporter-0", headers })).json();
    const version = source.source?.updated_at ?? source.updated_at;
    const changed = await app.inject({ method: "PATCH", url: "/api/admin/sources/event-reporter-0", headers,
      payload: { patch: { signal_group_id: "same-agency" }, version } });
    assert.equal(changed.statusCode, 200, changed.body);
    const source2 = (await app.inject({ url: "/api/admin/sources/event-reporter-1", headers })).json();
    const changed2 = await app.inject({ method: "PATCH", url: "/api/admin/sources/event-reporter-1", headers,
      payload: { patch: { signal_group_id: "same-agency" }, version: source2.source?.updated_at ?? source2.updated_at } });
    assert.equal(changed2.statusCode, 200, changed2.body);
    assert.equal((await app.inject({ url, headers })).json().propagation.independentReporters, 10);
    assert.equal(calls, before);
    const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
    const ruleChange = await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
      payload: { ...policy, editorial:{...policy.editorial,breakout:{...policy.editorial.breakout,reports:11}} } });
    assert.equal(ruleChange.statusCode, 200, ruleChange.body);
    assert.equal((await app.inject({ url, headers })).json().breakout.triggered, false, "数字门槛立即作用于当前观察，不重跑基础分析");
    assert.equal(calls, before);
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
      payload: { ...policy, version: ruleChange.json().policy.version } })).statusCode, 200);
    assert.equal((await app.inject({ url, headers })).json().breakout.triggered, true);
  } finally { important = false; }
});

test("百万播放按同平台三作者的最新作品指标统计，旧累计快照不叠加，指标更新不重新理解正文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T10:00:00Z") }); await resources.warm(); important = true;
  const accounts: string[] = [], posts: string[] = [];
  async function ingest(index: number, views: number | null) {
    return sql.begin(tx => saveCreatorContent(tx, accounts[index]!, "bilibili", { externalId: "BVshared000" + index,
      url: `https://www.bilibili.com/video/BVshared000${index}`, kind: "video", title: "星幕通用模型V2正式发布", text: "星幕发布通用模型V2。",
      publishedAt: "2026-10-24T10:00:00Z", transcript: null, metrics: { views, comments: null }, comments: [],
      commentCoverage: { complete: true, repliesComplete: true, limit: 20 } }));
  }
  const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/phase2-shared.mp4", kind: "audio" as const }),
    recognize: async () => ({ language: "zh", durationSeconds: 10, model: "external-shared-asr", segments: [{ start: 0, end: 10, text: "新模型暂未提供影视工具适配记录。" }] }) });
  transport.get("https://media.example").intercept({ path: "/phase2-shared.mp4" }).reply(200, Buffer.from("external-media-fixture")).times(4);
  try {
    for (let i = 0; i < 3; i++) {
      const followed = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: `https://space.bilibili.com/${900001 + i}` } });
      assert.equal(followed.statusCode, 200); accounts.push(followed.json().creator.id);
      posts.push(await ingest(i, [400000, 260000, 240000][i]!));
      assert.equal((await processor.process(posts[i]!)).mediaCleaned, true);
    }
    await scheduleTopicMaterialAnalyses(); await drain();
    const url = `/api/admin/studio/intelligence/creator:${posts[0]}/event`, before = calls;
    const first = (await app.inject({ url, headers })).json();
    assert.equal(first.propagation.platforms[0].observedViews, 900000); assert.equal(first.breakout.triggered, false);
    await ingest(0, 550000);
    const second = (await app.inject({ url, headers })).json();
    assert.equal(second.propagation.platforms[0].observedViews, 1050000);
    assert.equal(second.breakout.triggered, true); assert.ok(second.breakout.reasons.includes("observed_video_views:bilibili"));
    await ingest(0, 500000); await ingest(0, 500000);
    const final = (await app.inject({ url, headers })).json();
    assert.equal(final.propagation.platforms[0].observedViews, 1000000); assert.equal(final.propagation.platforms[0].independentAuthors, 3);
    assert.equal(final.breakout.triggered, true); assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0); assert.equal(calls, before);
    const linked = await app.inject({ method: "POST", url: "/api/admin/studio/creator-works", headers,
      payload: { title: "同一作品的转载发布", materialIds: posts.slice(0, 2).map(id => "creator:" + id) } });
    assert.equal(linked.statusCode, 200, linked.body);
    const deduped = (await app.inject({ url, headers })).json();
    assert.equal(deduped.propagation.platforms[0].observedViews, 740000); assert.equal(deduped.propagation.platforms[0].independentAuthors, 2);
    assert.equal(deduped.breakout.triggered, false); assert.equal(calls, before);
    const weibo = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
      payload: { url: "https://weibo.com/u/5756404150" } })).json().creator;
    const otherPost = { externalId: "5300000000000041", url: "https://weibo.com/5756404150/5300000000000041", kind: "video" as const,
      title: "星幕通用模型V2正式发布", text: "星幕发布通用模型V2。", publishedAt: "2026-10-24T10:00:00Z", transcript: null,
      metrics: { views: 800000 as number | null, comments: null }, comments: [], commentCoverage: { complete: true, repliesComplete: true, limit: 20 as const } };
    const otherId = await sql.begin(tx => saveCreatorContent(tx, weibo.id, "weibo", otherPost));
    assert.equal((await processor.process(otherId)).mediaCleaned, true); await scheduleTopicMaterialAnalyses(); await drain();
    const separate = (await app.inject({ url, headers })).json();
    assert.equal(separate.propagation.platforms.find((row: { platform: string }) => row.platform === "weibo").observedViews, 800000);
    assert.equal(separate.breakout.triggered, false, "不同平台的74万和80万不能合并为百万出圈"); assert.equal(calls, before);
    await sql.begin(tx => saveCreatorContent(tx, weibo.id, "weibo", { ...otherPost, metrics: { views: null, comments: null } }));
    const unknown = (await app.inject({ url, headers })).json().propagation.platforms.find((row: { platform: string }) => row.platform === "weibo");
    assert.equal(unknown.observedViews, null); assert.equal(unknown.measuredWorkCount, 0); assert.equal(calls, before);
  } finally { important = false; }
});

test("少量模仿案例不是定量出圈，无关娱乐也不能入候选", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T12:00:00Z") }); await resources.warm(); important = true;
  try {
    for (const scope of ["important_ai", "unrelated"] as const) {
      memeMode = scope;
      const saved = await upsertMaterial({ sourceId: "shared-first", title: "具体模仿案例" + scope, url: `https://shared-first.example/meme-${scope}`, via: "import",
        discoveredAt: new Date("2026-10-25T11:30:00Z"), publishedAt: new Date("2026-10-25T11:00:00Z"),
        bodyText: scope === "important_ai" ? "星幕V2角色转场在甲、乙、丙三位创作者的作品中出现了不同模仿案例。" : "某娱乐舞蹈在甲、乙、丙三位创作者中被模仿，与AI和影视制作没有关联。", bodyStatus: "ok" });
      await scheduleTopicMaterialAnalyses(); await drain();
      const event = (await app.inject({ url: `/api/admin/studio/intelligence/news:${saved.articleId}/event`, headers })).json();
      assert.equal(event.breakout.triggered, false);
      assert.equal(event.breakout.candidate, false);
    }
  } finally { important = false; memeMode = null; }
});

test("新报道在同一次基础分析中关联索引召回的原事件，措辞不同不新开一条付费归并链", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T11:00:00Z") }); await resources.warm(); important = true; reuseEvent = true;
  try {
    const original = (await app.inject({ url: `/api/admin/studio/intelligence/${foundationMaterialId}/event`, headers })).json();
    const before = calls;
    const saved = await upsertMaterial({ sourceId: "shared-first", title: "星幕V2发布的后续解读", url: "https://shared-first.example/foundation-explained", via: "import",
      discoveredAt: new Date("2026-10-25T10:30:00Z"), publishedAt: new Date("2026-10-25T10:00:00Z"),
      bodyText: "星幕通用模型V2于10月18日正式发布。这篇报道只解释原发布，不宣称新增功能。", bodyStatus: "ok" });
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await drain();
    const current = (await app.inject({ url: `/api/admin/studio/intelligence/news:${saved.articleId}/event`, headers })).json();
    assert.equal(current.event.id, original.event.id, "同一发布事件不同报道措辞沿用原事件");
    assert.equal(calls, before + 1, "事实理解与事件关联共用一次Flash请求");
  } finally { important = false; reuseEvent = false; }
});

test("付费响应后缓存提交失败，事件候选池变化也沿原请求恢复，不再付费或替换原判断", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T13:00:00Z") }); await resources.warm(); important = true;
  const before = calls, boss = await getBoss();
  const saved = await upsertMaterial({ sourceId: "shared-first", title: "星幕V2回存故障的原报道", url: "https://shared-first.example/paid-context-recovery", via: "import",
    discoveredAt: new Date("2026-10-25T12:30:00Z"), publishedAt: new Date("2026-10-25T12:00:00Z"), bodyText: "星幕V2发布的能力与限制以原始公告为准。", bodyStatus: "ok" });
  try {
    await scheduleTopicMaterialAnalyses(); const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await sql.unsafe("CREATE FUNCTION refuse_shared_cache() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shared-cache-write-refused'; END $$");
    await sql.unsafe("CREATE TRIGGER refuse_shared_cache BEFORE INSERT ON studio_material_analysis_cache FOR EACH ROW EXECUTE FUNCTION refuse_shared_cache()");
    try { await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /shared-cache-write-refused/); await boss.cancel(topicAnalysisQueue.name, job.id); }
    finally { await sql.unsafe("DROP TRIGGER refuse_shared_cache ON studio_material_analysis_cache"); await sql.unsafe("DROP FUNCTION refuse_shared_cache()"); }
    assert.equal(calls, before + 1);
    eventIdentitySuffix = ":new-candidate-after-failure";
    await upsertMaterial({ sourceId: "shared-second", title: "星幕V2新的相关事件候选", url: "https://shared-second.example/new-candidate", via: "import",
      discoveredAt: new Date("2026-10-25T12:35:00Z"), publishedAt: new Date("2026-10-25T12:15:00Z"), bodyText: "星幕V2新增一项配套说明，这里作为另一独立进展保存。", bodyStatus: "ok" });
    await scheduleTopicMaterialAnalyses(); await drain(); eventIdentitySuffix = "";
    const url = `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`;
    assert.equal((await app.inject({ url, headers })).json().state, "failed");
    assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queued, true); await drain();
    assert.equal((await app.inject({ url, headers })).json().state, "completed"); assert.equal(calls, before + 2);
  } finally { important = false; eventIdentitySuffix = ""; }
});
