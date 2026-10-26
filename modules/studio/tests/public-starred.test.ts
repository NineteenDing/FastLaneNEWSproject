import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
let calls = 0;
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++; const quote = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content).material.body;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: quote, reason: "角色制作工具新增参考控制", viewerBenefit: "判断跨镜头制作条件", event: null,
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 95, practical: 95, evidence: 95, freshness: null, demand: null, distinctiveness: 90 },
    shared: { scope: "direct", scopeReason: "影视工具更新", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: 95, reason: "用于制作" }, interest: { value: 95, reason: "创作者关心" }, substance: { value: 95, reason: "明确变化" } },
      columnMatches: [{ columnId: "models", value: 95, reason: "工具能力" }], reportingKind: "original", memeEvidence: [],
      event: { relation: "new", candidateId: null, label: "角色参考控制", identity: quote, quotes: [quote] } },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("访客收藏跨48小时仍可阅读，导入导出可恢复且恶意/超大文件不破坏原收藏，撤回优先", async t => {
  config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "star-test-only", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "phase2-stars", name: "收藏影视来源", kind: "rss", config: { feedUrl: "https://stars.example/rss" },
  } })).statusCode, 200);
  const now = Date.now(), title = "角色参考控制的制作条件";
  const { articleId: id } = await upsertMaterial({ sourceId: "phase2-stars", title, url: "https://stars.example/release", via: "import",
    publishedAt: new Date(now), bodyText: "角色制作工具新增参考控制，仍需检查多人镜头。", bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === "studio.news.publication.schedule")!.run();
  const paid = calls; assert.equal(paid, 1);
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const web = await startWebServer(app.server), browser = await chromium.launch(), context = await browser.newContext(), page = await context.newPage();
  const faults: string[] = []; page.on("pageerror", error => faults.push(error.message));
  try {
    await page.goto(web.origin + "/starred");
    await expect(page.getByText("还没有收藏内容。", { exact: false })).toBeVisible();
    await page.goto(web.origin + `/items/${id}`);
    await page.getByRole("button", { name: "收藏", exact: true }).first().click();
    await page.goto(web.origin + "/starred");
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("收藏只保存在当前浏览器", { exact: false })).toBeVisible();
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "导出", exact: true }).click();
    const saved = await download, exported = await readFile((await saved.path())!, "utf8"), bundle = JSON.parse(exported);
    assert.equal(bundle.version, 1); assert.equal(bundle.starred.length, 1); assert.equal(bundle.starred[0].id, id);
    await page.getByRole("button", { name: "取消收藏", exact: true }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);
    const upload = async (text: string) => page.locator('input[type="file"]').setInputFiles({ name: "favorites.json", mimeType: "application/json", buffer: Buffer.from(text) });
    await upload(exported); await expect(page.getByRole("status")).toContainText("新增收藏 1 条");
    await page.reload(); await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    await upload(exported); await expect(page.getByRole("status")).toContainText("新增收藏 0 条");
    await upload("malformed-json"); await expect(page.getByRole("status")).toContainText("不是有效的 JSON");
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

    t.mock.timers.enable({ apis: ["Date"], now: now + 49 * 3600000 });
    assert.ok(!(await app.inject({ url: "/api/site/pool?limit=30" })).body.includes(title), "48小时外离开动态列表");
    assert.equal((await app.inject({ url: `/api/site/items/${id}` })).statusCode, 200, "收藏原文稳定地址不随列表过期");
    await page.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.goto(web.origin + "/starred");
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/content/${id}/visibility`, headers,
      payload: { version: 0, visibility: "withdrawn", reason: "来源方下架" } })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/site/items/${id}` })).statusCode, 404);
    await page.reload(); await expect(page.getByText("这条内容已不再公开", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);

    const long = "工具".repeat(90) + "X".repeat(360), unsafe = '<img src=x onerror="alert(1)">';
    await upload(JSON.stringify({ version: 1, starred: [bundle.starred[0], { id: "long-safe", title: long, summary: unsafe, sourceName: "示例本地收藏" },
      { id: "javascript:alert(1)", title: "拒绝危险链接" }] }));
    await expect(page.getByRole("status")).toContainText("新增收藏 1 条");
    await expect(page.getByText(unsafe, { exact: true })).toBeVisible();
    await expect(page.locator('img[onerror], a[href^="javascript:"]')).toHaveCount(0);
    await upload(" ".repeat(8_000_001));
    await expect(page.getByRole("status")).toContainText("文件过大");
    await expect(page.getByRole("heading", { name: long, exact: true })).toBeVisible();
    await mkdir(".impeccable/review", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, `收藏长标题${width}不能横溢`);
      await page.screenshot({ path: `.impeccable/review/phase2-starred-${width}.png`, fullPage: true });
    }
    const other = await browser.newContext(), otherPage = await other.newPage();
    try { await otherPage.goto(web.origin + "/starred"); await expect(otherPage.getByText("还没有收藏内容。", { exact: false })).toBeVisible(); }
    finally { await other.close(); }
    assert.deepEqual(faults, []); assert.equal(calls, paid, "收藏/导入/导出/旧链接/页面不能调用模型");
  } finally { await context.close(); await browser.close(); await web.stop(); }
});
