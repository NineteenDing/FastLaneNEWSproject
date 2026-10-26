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
import { serverModules } from "@aihot/backend/modules";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
const requests: Array<{ task?: string; columns: Array<{ id: string }> }> = [];
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content); requests.push(input);
  const quote = input.material?.body ?? input.understanding?.shared?.facts[0].quotes[0], related = !quote.includes("足球");
  const output = input.task === "match_columns" ? { needsBody: false, matches: input.columns.map((column: { id: string }) => ({
    columnId: column.id, value: 95, reason: "新标准覆盖实际连续镜头限制", viewerBenefit: column.id === "models" ? "了解工具的限制" : "按连续镜头限制安排制作", evidenceQuotes: [quote],
  })) } : { columnId: related ? "models" : "other", disposition: related ? "support" : "not_topic", summary: quote, reason: "依实际正文判断",
    viewerBenefit: related ? "了解工具的限制" : null, event: null, evidenceQuotes: [quote], entities: [],
    gates: { audience: related, evidence: true, benefit: related }, dimensions: { audience: related ? 90 : 0, practical: 80, evidence: 90, freshness: null, demand: null, distinctiveness: 70 },
    shared: { scope: related ? "direct" : "unrelated", scopeReason: "依正文范围", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: 80, reason: "制作能力" }, interest: { value: 65, reason: "值得了解" }, substance: { value: 80, reason: "有具体限制" } },
      columnMatches: related ? [{ columnId: "models", value: 80, reason: "工具能力" }] : [], reportingKind: "original", event: null, memeEvidence: [] } };
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 80, completion_tokens: 80 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
async function drain() { const boss = await getBoss(); for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) return;
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); } }
let filmId = "", frozenUrl = "";

test("栏目标准更新后后台重判近期当前分类，列表和评分同步，冻结批次保持不变", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "classification-test-key", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "current-columns", name: "当前分类测试", kind: "rss", config: { feedUrl: "https://current-columns.example/feed" } } });
  const film = await upsertMaterial({ sourceId: "current-columns", title: "连续镜头工具", url: "https://current-columns.example/film", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: "角色参考支持连续镜头控制，只能用于单人场景。", bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "current-columns", title: "足球赛", url: "https://current-columns.example/sport", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "足球比赛今晚开始，尚未公布出场名单。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); const batchId = frozen.json().batch.id;
  const batchUrl = `/api/admin/studio/topic-batches/${batchId}/analysis`, readingUrl = `/api/admin/studio/intelligence/news:${film.articleId}/analysis`;
  filmId = `news:${film.articleId}`; frozenUrl = batchUrl;
  await app.inject({ method: "POST", url: batchUrl, headers, payload: {} }); await drain(); const before = (await app.inject({ url: batchUrl, headers })).json();
  assert.equal(requests.length, 2); assert.equal((await app.inject({ url: readingUrl, headers })).json().result.columnId, "models");
  const publish = serverModules().find(module => module.name === "studio")!.schedules!.find(schedule => schedule.name === "studio.news.publication.schedule")!;
  await publish.run(); assert.equal((await app.inject({ url: `/api/site/items/${film.articleId}` })).json().category, "models");
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 1, requirements: "优先解释连续镜头限制和适用条件。" } });
  assert.equal(changed.statusCode, 200, changed.body);
  await app.inject({ url: readingUrl, headers }); assert.equal(requests.length, 2, "读页面不提交模型请求");
  await publish.run(); assert.equal((await app.inject({ url: `/api/site/items/${film.articleId}` })).json().category, "models", "等待新匹配时保留上次成功分类");
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2); await drain();
  const reading = (await app.inject({ url: readingUrl, headers })).json();
  assert.equal(reading.result.columnId, "practice"); assert.equal(reading.classification.state, "completed");
  await publish.run(); assert.equal((await app.inject({ url: `/api/site/items/${film.articleId}` })).json().category, "practice");
  assert.equal(reading.batchOwnsVersion, true); assert.equal(reading.result.columnSnapshot.version, 2);
  const list = await app.inject({ url: "/api/admin/studio/intelligence?column=practice&limit=1", headers });
  assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().total, 1); assert.equal(list.json().rows[0].id, `news:${film.articleId}`);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?column=models", headers })).json().total, 0);
  const scored = (await app.inject({ url: `/api/admin/studio/intelligence/news:${film.articleId}/scoring`, headers })).json();
  assert.ok(scored.columnMatches.some((match: { columnId: string; value: number }) => match.columnId === "practice" && match.value === 95));
  assert.equal(requests.length, 3); assert.deepEqual(requests.at(-1)!.columns.map(column => column.id), ["practice"]);
  assert.deepEqual((await app.inject({ url: batchUrl, headers })).json(), before);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0); assert.equal(requests.length, 3);
});

test("当前栏目匹配中断不自动复活，批次拥有的材料也能单独显式恢复，缓存不重复收费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const url = `/api/admin/studio/intelligence/${filmId}`, frozen = (await app.inject({ url: frozenUrl, headers })).json();
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 2, requirements: "优先实际比较连续镜头控制的适用条件。" } });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2);
  const waiting = (await app.inject({ url: url + "/analysis", headers })).json();
  assert.equal(waiting.result.columnId, "practice", "重判期间保留上次成功分类，不退回最初栏目");
  const boss = await getBoss(); let selected: { id: string; data: unknown } | undefined;
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    if ((job.data as { classification: { materialId: string } }).classification.materialId === filmId) { selected = job; break; }
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await sql.unsafe(`CREATE FUNCTION reject_current_classification_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'classification-save-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_current_classification BEFORE UPDATE ON studio_current_material_classifications FOR EACH ROW EXECUTE FUNCTION reject_current_classification_save()");
  try { await assert.rejects(topicAnalysisQueue.run([selected.data] as never[]), /classification-save-refused/); await boss.cancel(topicAnalysisQueue.name, selected.id); }
  finally { await sql.unsafe("DROP TRIGGER reject_current_classification ON studio_current_material_classifications"); await sql.unsafe("DROP FUNCTION reject_current_classification_save()"); }
  await drain(); const paid = requests.length;
  const failed = (await app.inject({ url: url + "/analysis", headers })).json(); assert.equal(failed.state, "completed"); assert.equal(failed.classification.state, "failed");
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0); assert.equal(requests.length, paid);
  assert.equal((await app.inject({ method: "POST", url: url + "/classification", payload: {} })).statusCode, 401);
  const noCsrf = { cookie: headers.cookie }; assert.equal((await app.inject({ method: "POST", url: url + "/classification", headers: noCsrf, payload: {} })).statusCode, 403);
  const retry = await app.inject({ method: "POST", url: url + "/classification", headers, payload: {} });
  assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().queued, true); await drain();
  const recovered = (await app.inject({ url: url + "/analysis", headers })).json();
  assert.equal(recovered.classification.state, "completed"); assert.equal(recovered.result.columnId, "practice"); assert.equal(recovered.result.columnSnapshot.version, 3);
  assert.equal(requests.length, paid); assert.deepEqual((await app.inject({ url: frozenUrl, headers })).json(), frozen);
});

test("改名排序只更新当前名称，停用原主栏目时重新核对接收栏目的收益", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const url = `/api/admin/studio/intelligence/${filmId}/analysis`, before = requests.length;
  const renamed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 3, name: "连续镜头实操", sortOrder: 12 } });
  assert.equal(renamed.statusCode, 200, renamed.body); assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
  const reading = (await app.inject({ url, headers })).json(); assert.equal(reading.result.columnSnapshot.name, "连续镜头实操"); assert.equal(requests.length, before);
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 4, enabled: false } });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2); await drain();
  const moved = (await app.inject({ url, headers })).json(); assert.equal(moved.result.columnId, "models");
  assert.equal(moved.result.viewerBenefit, "了解工具的限制", "停用原栏目后不能套用原栏目收益");
  assert.equal(requests.length, before + 1); assert.deepEqual(requests.at(-1)!.columns.map(column => column.id), ["models"]);
});

test("规则连续变化时过期任务不再付费，恢复相同含义可以继续匹配", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const before = requests.length, first = "只收录明确说明连续镜头失败条件的材料。";
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 5, enabled: true, requirements: first } });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2);
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 6, requirements: "只收录明确说明连续镜头复现参数的材料。" } });
  await drain(); assert.equal(requests.length, before, "付费前发现栏目已变更应终止过期任务");
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 7, requirements: first } });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2, "不能被旧的过期记录永久阻塞"); await drain();
  assert.equal(requests.length, before + 1); assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${filmId}/analysis`, headers })).json().classification.state, "completed");
});

test("实际网页能恢复批次材料的栏目匹配，桌面与手机显示清楚且页面读取不付费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 8, requirements: "优先能演示适用边界的连续镜头提示。" } });
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 2); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break;
    if ((job.data as { classification: { materialId: string } }).classification.materialId === filmId) await boss.cancel(topicAnalysisQueue.name, job.id);
    else { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); } }
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { mkdir } = await import("node:fs/promises"); await mkdir(".impeccable/review", { recursive: true });
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const before = requests.length;
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/${filmId}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "已保存的材料初筛", exact: true });
    await expect(panel).toContainText("栏目匹配：更新未完成，可重试"); assert.equal(requests.length, before);
    await panel.getByRole("button", { name: "重试栏目匹配", exact: true }).click();
    await expect(panel).toContainText("栏目匹配：已排队"); await drain();
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click();
    await expect(panel).toContainText("已按当前标准更新"); await expect(panel.getByRole("button", { name: "重试栏目匹配", exact: true })).toHaveCount(0);
    await expect(panel).toContainText("所属批次仍保留归档版本"); assert.equal(requests.length, before + 1);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 }); assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await panel.screenshot({ path: `.impeccable/review/phase2-current-classification-${width}.png` });
    }
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click(); assert.equal(requests.length, before + 1);
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
