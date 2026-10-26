import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue, scheduleTopicGenerations } from "../backend/topic-directions.ts";
import { topicReviewQueue } from "../backend/topic-review.ts";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit controlled localhost model boundary in this test process.
const inputs: Array<Record<string, any>> = [];
let reviewedBatchId = "";
const provider = await stub((_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  inputs.push(input);
  if (input.task === "review_packet") return { choices: [{ message: { content: JSON.stringify({ checkedParts: input.parts.map((part: {id: string}) => part.id), opinions: input.round === 1 ? [
    { id: "timing", directionIds: ["c-old-tutorial"], materialIds: [], kind: "timing", severity: "major", problem: "旧教程需明确时效口径", suggestion: "保留实际时效说明与适用条件" }
  ] : [] }) } }] };
  if (input.task === "review_summary") return { choices: [{ message: { content: JSON.stringify({ passed: input.round === 2, opinionIds: input.opinions.map((opinion: {id: string}) => opinion.id), summary: "核对时效与原文条件" }) } }] };
  if (["revise", "adjudicate"].includes(input.task)) return { choices: [{ message: { content: JSON.stringify({ recommendation: { assignments: input.recommendation.assignments,
    directions: input.recommendation.directions.map(({ score: _score, ...direction }: Record<string, unknown>) => direction) },
    decisions: input.opinions.map((opinion: {id: string}) => ({ opinionId: opinion.id, decision: "accept", reason: "保持原始日期和条件" })), summary: "已按意见保留时效口径" }) } }] };
  const dimensions = { audience: 100, practical: 100, evidence: 100, freshness: 100, demand: 100, distinctiveness: 100 }, gates = { audience: true, evidence: true, benefit: true };
  if (input.material) return { choices: [{ message: { content: JSON.stringify({ columnId: "other", disposition: "support", summary: "角色参考检查", reason: "有可演示步骤", viewerBenefit: "减少角色漂移", event: input.material.title,
    evidenceQuotes: ["准备固定角色参考图。"], dimensions, gates, entities: [] }) } }] };
  const materials = input.materials.map((row: { material: { id: string; title: string; body: string } }) => row.material);
  return { choices: [{ message: { content: JSON.stringify({ directions: materials.map((material: { id: string; title: string; body: string }) => ({
    id: material.title, columnId: "other", eventKey: material.title, question: material.title, viewerBenefit: "检查角色参考，减少镜头返工", whyNow: "当前资料有可演示步骤", angle: material.title,
    usage: { steps: ["准备固定角色参考图。"], conditions: ["已有角色参考"], limitations: ["需要实际样片确认"] }, titles: [material.title, material.title + "的检查步骤", material.title + "的适用条件"], preferredTitle: 0,
    structure: { opening: "展示角色漂移", rhythm: "问题后给操作", ending: "说明限制" }, references: [{ materialId: material.id, role: "fact", quote: material.body.includes("新增逐镜头检查功能。") ? "新增逐镜头检查功能。" : "准备固定角色参考图。", reason: "实际操作步骤" },
      { materialId: material.id, role: "expression", quote: "准备固定角色参考图。", reason: "先给具体操作，再说明检查限制" }], dimensions, gates,
  })), assignments: materials.map((material: { id: string; title: string }) => ({ materialId: material.id, columnId: "other", disposition: "support", directionIds: [material.title], reason: "本方向的实际步骤" })) }) } }] };
});

async function verifyRuleVersion(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 8 * 86400000 }); await resources.warm();
  const root = `/api/admin/studio/topic-batches/${reviewedBatchId}`, url = root + "/versions";
  const before = (await app.inject({ url: root, headers })).json().batch, reviewBefore = (await app.inject({ url: root + "/review", headers })).json();
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 2, name: "镜头提效", requirements: "必须展示两个镜头的实际检查步骤，保留来源与条件。" } }); assert.equal(changed.statusCode, 200);
  const columns = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows.map((column: { id: string; version: number }) => ({ id: column.id, version: column.version }));
  assert.equal((await app.inject({ method: "POST", url, payload: { columns } })).statusCode, 401);
  const created = await app.inject({ method: "POST", url, headers, payload: { columns } }); assert.equal(created.statusCode, 200);
  assert.notEqual(created.json().batchId, reviewedBatchId); assert.equal(created.json().queuedCount, 4);
  const version = `/api/admin/studio/topic-batches/${created.json().batchId}`;
  const detail = (await app.inject({ url: version, headers })).json().batch;
  assert.equal(detail.rootBatchId, reviewedBatchId); assert.equal(detail.revision, 2);
  assert.equal(detail.startsAt, before.startsAt); assert.equal(detail.endsAt, before.endsAt); assert.equal(detail.materialCount, 4);
  assert.equal(detail.columns.find((column: { id: string }) => column.id === "practice").version, 3);
  assert.deepEqual((await app.inject({ url: version + "/materials", headers })).json(), (await app.inject({ url: root + "/materials", headers })).json());
  assert.deepEqual((await app.inject({ url: version + "/coverage", headers })).json(), (await app.inject({ url: root + "/coverage", headers })).json());
  const duplicate = await app.inject({ method: "POST", url, headers, payload: { columns } }); assert.equal(duplicate.json().batchId, created.json().batchId); assert.equal(duplicate.json().queuedCount, 0);
  const boss = await getBoss(); for (const job of await boss.fetch(topicAnalysisQueue.name, { batchSize: 10 })) { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  assert.equal((await scheduleTopicGenerations()).queued, 1);
  const [generation] = await boss.fetch(topicGenerationQueue.name); assert.ok(generation); await topicGenerationQueue.run([generation.data] as never[]); await boss.complete(topicGenerationQueue.name, generation.id);
  assert.equal((await app.inject({ method: "POST", url: version + "/review", headers, payload: {} })).statusCode, 200);
  const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review); await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
  assert.equal((await app.inject({ url: version + "/review", headers })).json().rounds.length, 2);
  const revisionInputs = inputs.filter(input => input.columns?.some((column: {id: string; version: number}) => column.id === "practice" && column.version === 2));
  assert.ok(inputs.some(input => input.material && input.columns?.some((column: { id: string; requirements: string }) =>
    column.id === "practice" && column.requirements === "必须展示两个镜头的实际检查步骤，保留来源与条件。")), "材料分析实际使用更新的语义标准，展示版本号不进入共享理解缓存");
  assert.ok(revisionInputs.some(input => input.task === "review_packet"));
  assert.deepEqual((await app.inject({ url: root, headers })).json().batch, before);
  assert.deepEqual((await app.inject({ url: root + "/review", headers })).json(), reviewBefore);
  assert.equal((await app.inject({ url: version + "/versions", headers })).json().rows.length, 2);
  const staleColumns = columns.map((column: {id: string; version: number}) => ({...column, version: 1}));
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { columns: staleColumns } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url, headers: {cookie: headers.cookie}, payload: { columns } })).statusCode, 403);
  config.modelCallsEnabled = false;
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {columns} })).statusCode, 409);
  config.modelCallsEnabled = true;
  const calls = provider.hits(), web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: {width: 1440, height: 1000} });
    await page.goto(web.origin + `/admin/studio/topics/batches/${reviewedBatchId}`); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    await page.getByText("选题版本与最新规则 · 当前版本 1", {exact: true}).click();
    await expect(page.getByRole("navigation", {name: "本批次选题版本", exact: true})).toBeVisible();
    await expect(page.getByText("镜头提效 · 版本 2 · 已启用", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "按最新规则新建选题版本", exact: true}).click();
    await page.waitForURL(web.origin + `/admin/studio/topics/batches/${created.json().batchId}`);
    await openTopicProcessing(page);
    await page.getByText("选题版本与最新规则 · 当前版本 2", {exact: true}).click();
    await expect(page.getByText("当前版本已使用最新栏目规则，无需重复选题。", {exact: true})).toBeVisible();
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({width, height: 1000}); await page.getByText("选题版本与最新规则 · 当前版本 2", {exact: true}).evaluate("element => element.scrollIntoView({block:'center'})");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({path: `.impeccable/review/topic-rule-version-${suffix}.png`});
    }
    await page.getByRole("navigation", {name: "本批次选题版本", exact: true}).getByRole("link", {name: "版本 1", exact: true}).click();
    await page.waitForURL(web.origin + `/admin/studio/topics/batches/${reviewedBatchId}`); assert.equal(provider.hits(), calls);
  } finally { await browser.close(); await web.stop(); }
}
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("方向保留来源多样性，缺事件时间不按发布时间补时效，未知热度和影响不获补偿", async t => {
  config.modelCallsEnabled = true;
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-ranking-key", LLM_MODEL: "isolated-ranking-model" });
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json(), end = Date.parse(window.endsAt);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, startsAt: window.startsAt, enabled: false } })).statusCode, 200);
  for (const source of ["rank-a", "rank-b", "rank-c"]) assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: source, name: source, kind: "rss", config: { feedUrl: `https://${source}.example/rss` } } })).statusCode, 200);
  for (const [title, sourceId, ageHours] of [["a-one", "rank-a", 0], ["a-two", "rank-a", 0], ["b-independent", "rank-b", 0], ["c-old-tutorial", "rank-c", 72]] as const) {
    await upsertMaterial({ sourceId, title, url: `https://${sourceId}.example/${title}`, via: "import", discoveredAt: new Date(end - 3600000), publishedAt: new Date(end - ageHours * 3600000), bodyText: "准备固定角色参考图。", bodyStatus: "ok" });
  }
  t.mock.timers.enable({ apis: ["Date"], now: end }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: window.startsAt } }); assert.equal(frozen.statusCode, 200);
  const endpoint = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  reviewedBatchId = frozen.json().batch.id;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/analysis", headers, payload: {} })).json().queuedCount, 4);
  const boss = await getBoss(), analyses = await boss.fetch(topicAnalysisQueue.name, { batchSize: 10 }); assert.equal(analyses.length, 4);
  for (const job of analyses) { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/recommendations", headers, payload: {} })).statusCode, 200);
  const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job); await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const saved = (await app.inject({ url: endpoint + "/recommendations", headers })).json().result;
  assert.equal(saved.directions[0].score.ranking?.policy, "studio-direction-ranking-v2");
  assert.deepEqual(saved.directions.map((direction: { id: string }) => direction.id), ["a-one", "b-independent", "c-old-tutorial", "a-two"]);
  assert.deepEqual(saved.directions.map((direction: { score: { total: number } }) => direction.score.total), [35, 35, 35, 33]);
  assert.equal(saved.directions[3].score.ranking.diversityAdjustment, -2); assert.equal(saved.directions[2].score.ranking.timeAdjustment, 0);
  assert.equal(saved.directions[2].score.dimensions.practical, 100); assert.equal(saved.assignments.length, 4);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/review", headers, payload: {} })).statusCode, 200);
  const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review); await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
  const reviewed = (await app.inject({ url: endpoint + "/review", headers })).json(); assert.equal(reviewed.state, "completed"); assert.equal(reviewed.rounds.length, 2);
  assert.deepEqual(reviewed.result.directions.map((direction: {score: {total: number}}) => direction.score.total), [35, 35, 35, 33]);
  assert.equal(reviewed.result.directions[3].score.ranking.asOf, window.endsAt);
  const reviewInputs = inputs.filter(input => input.task === "review_packet"); assert.equal(reviewInputs.length, 2);
  assert.ok(reviewInputs.every(input => input.rankingContext.asOf === window.endsAt && input.rankingRules.scope === "within_column" && input.rankingRules.timeScope === "configured_event_time_bands"));
  t.mock.timers.setTime(end + 30 * 86400000);
  const calls = provider.hits(); assert.deepEqual((await app.inject({ url: endpoint + "/recommendations", headers })).json().result, saved); assert.equal(provider.hits(), calls);
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + `/admin/studio/topics/batches/${frozen.json().batch.id}`); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "最终选题推荐", exact: true }).locator(".studio-direction-column > summary").filter({ hasText: "其他" }).click();
    const direction = page.locator("#topic-final-c-old-tutorial"); await direction.locator(":scope > summary").click();
    await expect(direction.getByRole("list", {name: "建议学习的表达参考", exact: true})).toContainText("rank-c");
    await direction.getByText("查看评分与排序依据", { exact: true }).click();
    await expect(direction.getByText("六维基础分 35", { exact: false })).toContainText("最终 35.00 分");
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await direction.getByText("查看评分与排序依据", { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/topic-ranking-${suffix}.png` });
    }
    assert.equal(provider.hits(), calls);
  } finally { await browser.close(); await web.stop(); }
});

test("只有已审核方向可提交明确反馈，私有保存和多窗口冲突不改写旧选题或触发模型", async () => {
  const endpoint = `/api/admin/studio/topic-batches/${reviewedBatchId}`, url = endpoint + "/directions/a-two/feedback";
  const old = (await app.inject({ url: endpoint + "/review", headers })).json(), calls = provider.hits();
  assert.equal((await app.inject({ url })).statusCode, 401);
  const initial = await app.inject({ url, headers }); assert.equal(initial.statusCode, 200); assert.equal(initial.headers["cache-control"], "no-store");
  assert.deepEqual(initial.json().feedback, { version: 0, rating: null, reason: "", updatedAt: null });
  const saved = await app.inject({ method: "PUT", url, headers, payload: { version: 0, rating: "useful", reason: "操作条件明确，愿意继续看这个问题" } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().feedback.version, 1); assert.equal(saved.json().feedback.rating, "useful");
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 0, rating: "not_useful", reason: "过期窗口" } })).statusCode, 409);
  assert.deepEqual((await app.inject({ url, headers })).json(), saved.json());
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload: { version: 1, rating: null, reason: "" } })).statusCode, 403);
  const missing = endpoint + "/directions/not-a-direction/feedback";
  assert.equal((await app.inject({ method: "PUT", url: missing, headers, payload: { version: 0, rating: "useful", reason: "" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: 1, rating: "useful", reason: "x".repeat(1001) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: endpoint + "/directions/a-one/feedback", headers, payload: { version: 0, rating: "not_useful", reason: "这个角度不适合我" } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: endpoint + "/review", headers })).json(), old);
  assert.equal(provider.hits(), calls);
});

test("下一批次只冻结明确反馈并有界校准，提交后撤回不改变两轮审核的同版偏好，也不把未采纳视为差评", async t => {
  const oldEndpoint = `/api/admin/studio/topic-batches/${reviewedBatchId}`;
  const old = (await app.inject({ url: oldEndpoint, headers })).json().batch;
  const startsAt = old.endsAt, end = Date.parse(startsAt) + 48 * 3600000;
  for (const [title, sourceId, ageHours] of [["a-one", "rank-a", 0], ["a-two", "rank-a", 0], ["b-independent", "rank-b", 0], ["c-old-tutorial", "rank-c", 72]] as const)
    await upsertMaterial({ sourceId, title, url: `https://${sourceId}.example/next-${title}`, via: "import", discoveredAt: new Date(end - 3600000), publishedAt: new Date(end - ageHours * 3600000), bodyText: "准备固定角色参考图。", bodyStatus: "ok" });
  t.mock.timers.enable({ apis: ["Date"], now: end }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } }); assert.equal(frozen.statusCode, 200);
  const endpoint = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/analysis", headers, payload: {} })).json().queuedCount, 4);
  for (const job of await boss.fetch(topicAnalysisQueue.name, { batchSize: 10 })) { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/recommendations", headers, payload: {} })).statusCode, 200);
  for (const id of ["a-one", "a-two"]) assert.equal((await app.inject({ method: "PUT", url: `${oldEndpoint}/directions/${id}/feedback`, headers, payload: { version: 1, rating: null, reason: "" } })).statusCode, 200);
  const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job); await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const result = (await app.inject({ url: endpoint + "/recommendations", headers })).json().result;
  assert.deepEqual(result.directions.map((direction: { id: string }) => direction.id), ["a-two", "b-independent", "c-old-tutorial", "a-one"]);
  assert.deepEqual(result.directions.map((direction: { score: { total: number } }) => direction.score.total), [35.6, 35, 35, 32.4]);
  assert.deepEqual(result.directions.map((direction: { score: { ranking: { preferenceAdjustment: number } } }) => direction.score.ranking.preferenceAdjustment), [.6, 0, 0, -.6]);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/review", headers, payload: {} })).statusCode, 200);
  const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review); await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
  const final = (await app.inject({ url: endpoint + "/review", headers })).json(); assert.equal(final.rounds.length, 2); assert.deepEqual(final.result, result);
  const calibrated = inputs.filter(input => input.rankingContext?.policy === "studio-direction-ranking-v3-feedback");
  assert.ok(calibrated.length >= 5); assert.ok(calibrated.every(input => input.rankingContext.feedback.length === 2 && input.rankingRules.maxPreferenceAdjustment === 3));
  assert.ok(calibrated.every(input => !input.rankingContext.feedback.some((sample: { directionId: string }) => sample.directionId === "b-independent")));
  const cleared = (await app.inject({ url: oldEndpoint + "/directions/a-two/feedback", headers })).json().feedback;
  assert.equal(cleared.version, 2); assert.equal(cleared.rating, null);
  const calls = provider.hits(), web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + `/admin/studio/topics/batches/${frozen.json().batch.id}`); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "最终选题推荐", exact: true }).locator(".studio-direction-column > summary").filter({ hasText: "其他" }).click();
    const direction = page.locator("#topic-final-a-two"); await direction.locator(":scope > summary").click();
    await direction.getByText("选题反馈", { exact: true }).click();
    const editor = direction.getByRole("group", { name: "这个方向是否适合你", exact: true });
    await expect(editor).toBeVisible(); await editor.getByLabel("评价", { exact: true }).selectOption("useful");
    await editor.getByLabel("原因（可选）", { exact: true }).fill("这种可演示的步骤很适合我"); await direction.getByRole("button", { name: "保存反馈", exact: true }).click();
    await expect(direction.getByText("反馈已保存，将供后续批次参考。", { exact: true })).toBeVisible();
    assert.equal((await app.inject({ url: endpoint + "/directions/a-two/feedback", headers })).json().feedback.rating, "useful");
    assert.equal((await app.inject({ method: "PUT", url: endpoint + "/directions/a-two/feedback", headers, payload: { version: 1, rating: "not_useful", reason: "另一窗口已修改" } })).statusCode, 200);
    await editor.getByLabel("原因（可选）", { exact: true }).fill("当前窗口未保存的原因"); await direction.getByRole("button", { name: "保存反馈", exact: true }).click();
    await expect(direction.getByText("反馈尚未保存，编辑仍保留。若提示版本冲突，请先刷新反馈再修改。", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("原因（可选）", { exact: true })).toHaveValue("当前窗口未保存的原因");
    page.once("dialog", dialog => dialog.accept()); await direction.getByRole("button", { name: "刷新反馈", exact: true }).click();
    await expect(editor.getByLabel("评价", { exact: true })).toHaveValue("not_useful"); await editor.getByLabel("评价", { exact: true }).selectOption("");
    await direction.getByRole("button", { name: "保存反馈", exact: true }).click(); await expect(direction.getByText("反馈已撤回，后续批次不再使用这条评价。", { exact: true })).toBeVisible();
    await direction.getByText("查看评分与排序依据", { exact: true }).click(); await expect(direction.getByText("明确反馈调整", { exact: false })).toContainText("0.60");
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await editor.evaluate("element => element.scrollIntoView({ block: 'center' })");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/topic-feedback-${suffix}.png` });
    }
    assert.equal(provider.hits(), calls);
  } finally { await browser.close(); await web.stop(); }
});

test("往期实际采纳的相同事件角度没有新事实引文时降权，已有新增依据的方向不扣分，旧稿和旧批次不重算", async t => {
  const firstEndpoint = `/api/admin/studio/topic-batches/${reviewedBatchId}`;
  const first = (await app.inject({ url: firstEndpoint, headers })).json().batch;
  const adopted = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: reviewedBatchId, directionIds: ["a-one", "a-two"] } });
  assert.equal(adopted.statusCode, 200); const draftId = adopted.json().id;
  const draftBefore = (await app.inject({ url: `/api/admin/studio/drafts/${draftId}`, headers })).json();
  const firstBefore = (await app.inject({ url: firstEndpoint + "/review", headers })).json();
  const start = Date.parse(first.endsAt) + 48 * 3600000, end = start + 48 * 3600000;
  for (const [title, sourceId, ageHours] of [["a-one", "rank-a", 0], ["a-two", "rank-a", 0], ["b-independent", "rank-b", 0], ["c-old-tutorial", "rank-c", 72]] as const)
    await upsertMaterial({ sourceId, title, url: `https://${sourceId}.example/third-${title}`, via: "import", discoveredAt: new Date(end - 3600000), publishedAt: new Date(end - ageHours * 3600000), bodyText: "准备固定角色参考图。" + (title === "a-two" ? "新增逐镜头检查功能。" : ""), bodyStatus: "ok" });
  t.mock.timers.enable({ apis: ["Date"], now: end }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: new Date(start).toISOString() } }); assert.equal(frozen.statusCode, 200);
  const endpoint = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, boss = await getBoss();
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/analysis", headers, payload: {} })).json().queuedCount, 4);
  for (const job of await boss.fetch(topicAnalysisQueue.name, { batchSize: 10 })) { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/recommendations", headers, payload: {} })).statusCode, 200);
  const [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job); await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
  const saved = (await app.inject({ url: endpoint + "/recommendations", headers })).json().result;
  assert.deepEqual(saved.directions.map((direction: { id: string }) => direction.id), ["a-two", "b-independent", "c-old-tutorial", "a-one"]);
  assert.deepEqual(saved.directions.map((direction: { score: { total: number } }) => direction.score.total), [35, 35, 35, 30]);
  assert.equal(saved.directions[3].score.ranking.adoptionAdjustment, -3); assert.equal(saved.directions[3].score.ranking.previousProjectId, draftId);
  assert.equal(saved.directions[0].score.ranking.adoptionAdjustment, 0); assert.equal(saved.assignments.length, 4);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/review", headers, payload: {} })).statusCode, 200);
  const [review] = await boss.fetch(topicReviewQueue.name); assert.ok(review); await topicReviewQueue.run([review.data] as never[]); await boss.complete(topicReviewQueue.name, review.id);
  assert.deepEqual((await app.inject({ url: endpoint + "/review", headers })).json().result, saved);
  assert.deepEqual((await app.inject({ url: firstEndpoint + "/review", headers })).json(), firstBefore);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/drafts/${draftId}`, headers })).json(), draftBefore);
});

test("对旧批次应用最新栏目规则建立独立版本，旧审核和稿件保留，原48小时材料不重复分配", verifyRuleVersion);
