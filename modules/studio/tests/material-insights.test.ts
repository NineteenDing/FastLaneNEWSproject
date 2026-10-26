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
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { weiboFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit local provider fixture; production guard remains enabled.
const body = "新功能允许固定同一角色参考图，暂时只支持单人镜头。";
const requests: Array<{ messages: Array<{ content: string }>; max_tokens: number }> = [];
let commentFocus: Array<{ point: string; evidence: Array<{ commentId: string; quote: string }> }> = [];
let impactQuote = body;
const provider = await stub((_hit, request) => {
  requests.push(JSON.parse(request.body));
  return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "固定角色参考的使用条件",
    reason: "可以演示参考图设置", viewerBenefit: "检查镜头一致性", event: "角色参考更新", evidenceQuotes: [body], entities: [],
    gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 90, practical: 80, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
    ...(requests.at(-1)!.messages[0]!.content.includes("commentFocus") ? { insights: { commentFocus,
      impacts: [{ effect: "可能减少单人镜头间的角色变化", conditions: "先固定同一参考图，仅讨论单人镜头，效果仍需实际检查", kind: "inferred", evidenceQuotes: [impactQuote] }] } } : {}),
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
});

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-insights-key", LLM_MODEL: "isolated-insights-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("同一次采中分析保存有条件和原文依据的影响判断，无评论不伪造关注点，截止直接复用", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "insights-news", name: "模型制作观察",
    kind: "rss", config: { feedUrl: "https://insights.example/feed" } } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "insights-news", title: "角色参考更新", url: "https://insights.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const id = "news:" + saved.articleId;
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  const reading = (await app.inject({ url: `/api/admin/studio/intelligence/${id}`, headers })).json();
  assert.equal(reading.analysis.state, "completed");
  assert.equal(reading.analysis.result.insights.policy, "grounded-insights-v1");
  assert.deepEqual(reading.analysis.result.insights.commentSample, { count: 0, complete: null, repliesComplete: null });
  assert.deepEqual(reading.analysis.result.insights.commentFocus, []);
  assert.equal(reading.analysis.result.insights.impacts[0].kind, "inferred");
  assert.equal(reading.analysis.result.insights.impacts[0].conditions, "先固定同一参考图，仅讨论单人镜头，效果仍需实际检查");
  assert.deepEqual(reading.analysis.result.insights.impacts[0].evidenceQuotes, [body]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.messages[0]!.content.includes("commentFocus"));
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime()); await resources.warm();
  const freeze = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(freeze.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${freeze.json().batch.id}`;
  assert.equal((await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} })).statusCode, 200);
  const [batchJob] = await boss.fetch(topicAnalysisQueue.name); assert.ok(batchJob);
  await topicAnalysisQueue.run([batchJob.data] as never[]); await boss.complete(topicAnalysisQueue.name, batchJob.id);
  assert.equal((await app.inject({ url: prefix + "/analysis", headers })).json().rows[0].insights.impacts[0].kind, "inferred");
  assert.equal(requests.length, 1, "评论和影响与原初筛共用一次判断和同版缓存");
});

test("模型编造评论关注点的引句或评论身份时不保存为实际分析", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T10:00:00Z") }); await resources.warm();
  commentFocus = [{ point: "用户要求批量制作", evidence: [{ commentId: "invented-comment", quote: "能批量生成吗？" }] }];
  const saved = await upsertMaterial({ sourceId: "insights-news", title: "没有评论的原文", url: "https://insights.example/fake-comment", via: "import",
    discoveredAt: new Date("2026-10-19T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /评论关注点/); await boss.cancel(topicAnalysisQueue.name, job.id);
  const read = (await app.inject({ url: `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, headers })).json();
  assert.equal(read.state, "failed"); assert.equal(read.result, null); commentFocus = [];
});

test("博主评论关注点保留实际评论身份和原句，样本范围由采集记录计算而非模型填写", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T10:00:00Z") }); await resources.warm();
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers, payload: { version: 0, cookie: "SUB=isolated-insights-session" } })).statusCode, 200);
    const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } });
    assert.equal(added.statusCode, 200); const creatorId = added.json().creator.id;
    weiboFixture(transport, { text: `<p>${body}</p>`, expectedCookie: "SUB=isolated-insights-session", replies: true });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    const boss = await getBoss(), [collect] = await boss.fetch(creatorQueue.name); assert.ok(collect);
    await creatorQueue.run([collect.data] as never[]); await boss.complete(creatorQueue.name, collect.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    commentFocus = [{ point: "样本中的用户在询问场景一致性", evidence: [{ commentId: "90001", quote: "怎么保持场景一致？" }] }];
    await scheduleTopicMaterialAnalyses(); const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    const before = requests.length; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
    assert.deepEqual(detail.analysis.result.insights.commentSample, { count: 2, complete: false, repliesComplete: false });
    assert.deepEqual(detail.analysis.result.insights.commentFocus, commentFocus);
    const material = JSON.parse(requests.at(-1)!.messages.at(-1)!.content).material;
    assert.equal(material.comments[0].externalId, "90001");
    assert.equal(material.comments[1].parentExternalId, "90001");
    assert.equal(material.commentCoverage, undefined, "完成范围由原采集记录投影，不改变同批评论文字的分析身份");
    assert.equal(requests.length, before + 1); transport.assertNoPendingInterceptors();
  } finally { commentFocus = []; setGlobalDispatcher(previous); await transport.close(); }
});

test("影响依据不在原文时不能保存成有据的判断", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T10:00:00Z") }); await resources.warm();
  impactQuote = "原文未提供的断言：已保证所有镜头角色完全一致。";
  const saved = await upsertMaterial({ sourceId: "insights-news", title: "影响引用测试", url: "https://insights.example/fake-impact", via: "import",
    discoveredAt: new Date("2026-10-23T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await assert.rejects(topicAnalysisQueue.run([job.data] as never[]), /影响/); await boss.cancel(topicAnalysisQueue.name, job.id);
  const read = (await app.inject({ url: `/api/admin/studio/intelligence/news:${saved.articleId}/analysis`, headers })).json();
  assert.equal(read.state, "failed"); assert.equal(read.result, null); impactQuote = body;
});

test("升级前已排队的采中和批次保留原初筛请求与缓存，缺失新分析不自动重复付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T10:00:00Z") }); await resources.warm();
  const saved = await upsertMaterial({ sourceId: "insights-news", title: "升级前的初筛", url: "https://insights.example/old-cache", via: "import",
    discoveredAt: new Date("2026-10-25T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
  const id = "news:" + saved.articleId, before = requests.length;
  await scheduleTopicMaterialAnalyses();
  // Upgrade fixture: reproduce the live JSON snapshot emitted before insights existed.
  await sql`UPDATE studio_live_material_analyses SET snapshot = snapshot - 'insightPolicy' - 'sharedPolicy' WHERE material_id = ${id}`;
  const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  const reading = (await app.inject({ url: `/api/admin/studio/intelligence/${id}/analysis`, headers })).json();
  assert.equal(reading.state, "completed"); assert.equal(reading.result.insights, undefined);
  assert.equal(requests.length, before + 1); assert.equal(requests.at(-1)!.messages[0]!.content.includes("commentFocus"), false);
  assert.equal(requests.at(-1)!.max_tokens, 6000); assert.ok(JSON.parse(requests.at(-1)!.messages.at(-1)!.content).analysisContext);
  t.mock.timers.setTime(new Date("2026-10-26T12:00:00Z").getTime()); await resources.warm();
  for (const startsAt of ["2026-10-18T12:00:00Z", "2026-10-20T12:00:00Z", "2026-10-22T12:00:00Z"])
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } })).statusCode, 200);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  const submit = await app.inject({ method: "POST", url: prefix + "/analysis", headers, payload: {} }); assert.equal(submit.statusCode, 200);
  // The old batch schema/job carried cache_policy but no insight_policy.
  await sql`UPDATE studio_topic_material_analyses SET insight_policy = NULL, cache_policy = 'material-cache-v1:media-observations-v1'
    WHERE batch_id = ${frozen.json().batch.id} AND material_id = ${id}`;
  await sql`UPDATE pgboss.job SET data = (data - 'insightPolicy' - 'sharedPolicy') || '{"cachePolicy":"material-cache-v1:media-observations-v1"}'::jsonb
    WHERE name = ${topicAnalysisQueue.name} AND data->>'batchId' = ${frozen.json().batch.id} AND data->>'materialId' = ${id}`;
  for (;;) { const [oldBatchJob] = await boss.fetch(topicAnalysisQueue.name); if (!oldBatchJob) break;
    await topicAnalysisQueue.run([oldBatchJob.data] as never[]); await boss.complete(topicAnalysisQueue.name, oldBatchJob.id); }
  const old = (await app.inject({ url: prefix + "/analysis", headers })).json().rows.find((row: { materialId: string }) => row.materialId === id);
  assert.equal(old.state, "completed"); assert.equal(old.insights, undefined); assert.equal(old.receiptId, reading.receiptId);
  assert.equal(requests.length, before + 1);
});

test("实际网页区分评论样本与影响推断，依据按需展开，冻结阅读及旧无字段结果不触发模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T10:00:00Z") }); await resources.warm();
  const batches = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().rows;
  const post = (await app.inject({ url: "/api/admin/studio/intelligence?platform=weibo", headers })).json().rows[0]; assert.ok(post);
  // Creator collection uses the database's real collection time; the fake JS clock only fixes scheduling.
  const batch = batches.find((row: { startsAt: string; endsAt: string }) => Date.parse(row.startsAt) <= Date.parse(post.collectedAt)
    && Date.parse(post.collectedAt) < Date.parse(row.endsAt)); assert.ok(batch);
  const legacy = batches.find((row: { startsAt: string }) => row.startsAt === "2026-10-24T12:00:00.000Z"); assert.ok(legacy);
  const before = requests.length;
  const submit = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${batch.id}/analysis`, headers, payload: {} }); assert.equal(submit.statusCode, 200);
  const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break;
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  assert.equal(requests.length, before, "有评论的同版分析也由截止直接复用");
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mkdir(".impeccable/review", { recursive: true });
  async function capture(path: string) {
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await expect(page.getByRole("link", { name: "跳到正文", exact: true })).not.toBeInViewport();
    await page.screenshot({ path, fullPage: true });
  }
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/${post.id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "评论与影响分析", exact: true });
    await expect(panel.getByText("样本中的用户在询问场景一致性", { exact: true })).toBeVisible();
    await expect(panel.getByText("仅基于已收录的 2 条评论样本", { exact: false })).toBeVisible();
    await expect(panel.getByText("推断：", { exact: true })).toBeVisible();
    await expect(panel.getByText("适用条件与限制：先固定同一参考图，仅讨论单人镜头，效果仍需实际检查", { exact: true })).toBeVisible();
    assert.equal(await panel.locator("details[open]").count(), 0);
    await capture(".impeccable/review/material-insights-desktop.png");
    await page.setViewportSize({ width: 390, height: 1100 });
    await panel.getByText("查看评论依据", { exact: true }).click(); await expect(panel.getByText("怎么保持场景一致？", { exact: false })).toBeVisible();
    await panel.getByText("查看影响依据", { exact: true }).click(); await expect(panel.getByRole("blockquote").last()).toHaveText(body);
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await capture(".impeccable/review/material-insights-mobile.png");
    let liveReads = 0; page.on("request", request => { if (/\/intelligence\/[^/]+\/analysis$/.test(new URL(request.url()).pathname)) liveReads++; });
    await page.goto(web.origin + `/admin/studio/topics/batches/${batch.id}`);
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "冻结材料", exact: true }).locator("summary").filter({ hasText: post.source.name }).first().click();
    await expect(panel.getByText("样本中的用户在询问场景一致性", { exact: true })).toBeVisible();
    await capture(".impeccable/review/material-insights-frozen-mobile.png");
    await page.goto(web.origin + `/admin/studio/topics/batches/${legacy.id}`);
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "冻结材料", exact: true }).locator("summary").first().click();
    await expect(panel.getByText("这次分析尚未保存评论关注点与影响判断，保留原文和实际评论供查看。", { exact: true })).toBeVisible();
    await expect(panel.getByText("样本中的用户在询问场景一致性", { exact: true })).toHaveCount(0);
    await capture(".impeccable/review/material-insights-legacy-mobile.png");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.waitForLoadState("networkidle"); assert.equal(liveReads, 0); assert.equal(requests.length, before);
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
