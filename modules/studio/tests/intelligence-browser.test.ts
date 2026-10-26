import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { createServer, request as forwardRequest } from "node:http";
import { chromium, expect, type Browser } from "@playwright/test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";
import { bilibiliFixture, weiboFixture, weiboVideoDetailFixture } from "./mediacrawler-fixture.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import sharp from "sharp";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

installModules(SERVER_MODULES);
const app = await buildApp(), previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
let browser: Browser, web: WebServer;
let adminHeaders: { cookie: string; "x-csrf-token": string };
let detailUnavailable = false;
before(async () => {
  config.adminPassword = "intelligence-browser-password"; config.siteUrl = "http://127.0.0.1";
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ username: config.adminUsername ?? "admin", password: "intelligence-browser-password" }).toString() });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!, me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  assert.equal(me.statusCode, 200); adminHeaders = { cookie, "x-csrf-token": me.json().csrf };
  const apiOrigin = await listenHttpForFetch(app.server);
  // A real HTTP fault at the API service boundary; keep the production web loader and router wire format.
  const api = createServer((request, response) => {
    if (detailUnavailable && request.url?.startsWith("/api/admin/studio/intelligence/")) {
      response.writeHead(503, { "content-type": "application/json" }); response.end('{"detail":"fixture unavailability"}'); return;
    }
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  web = await startWebServer(api); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("统一情报页显示真实新闻与博主资料，搜索全文、详情阅读及返回保持筛选，桌面和手机不溢出", async () => {
  const headers = adminHeaders;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "intelligence-browser-news", name: "影视工具观察", kind: "rss", config: { feedUrl: "https://news.example/rss" } } })).statusCode, 200);
  await upsertMaterial({ sourceId: "intelligence-browser-news", title: "视频工具更新：角色参考和镜头控制", url: "https://news.example/update", via: "import",
    publishedAt: new Date("2026-10-17T10:00:00Z"), discoveredAt: new Date(), bodyStatus: "ok",
    excerpt: "这次更新可以减少跨镜头的角色变化，原文同时说明了适用限制。", bodyText: "先固定角色，再调整镜头。\n" + "检查角色参考与镜头衔接。".repeat(25) + "\n使用条件：不同景别仍需检查一致性。<script>window.fixtureXSS=true</script>" });
  const added = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } })).json().creator;
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${added.id}/collect`, headers, payload: {} });
  bilibiliFixture(transport, { replies: true });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/intelligence");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "情报库", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "情报库" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("list", { name: "情报动态" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "角色一致性的方法" })).toBeVisible();
    await expect(page.getByText("新闻待处理 · 初筛待安排", { exact: true })).toBeVisible();
    await expect(page.getByText("作品已收录 · 初筛待安排", { exact: true })).toBeVisible();
    for (const [width, suffix] of [[1440, "desktop"], [1024, "tablet"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      await page.screenshot({ path: `.impeccable/review/intelligence-feed-${suffix}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await expect(page.getByLabel("搜索情报", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "日期归档", exact: true }).click();
    await page.getByLabel("搜索情报", { exact: true }).fill("使用条件");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("list", { name: "情报动态" }).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("heading", { name: "视频工具更新：角色参考和镜头控制" }).click();
    await expect(page.getByRole("heading", { name: "情报详情", exact: true })).toBeVisible();
    await expect(page.getByText("使用条件：不同景别仍需检查一致性。", { exact: false })).toBeVisible();
    assert.equal(await page.evaluate("Boolean(window.fixtureXSS)"), false);
    await expect(page.getByRole("link", { name: "打开原文或原作品", exact: true })).toHaveAttribute("href", "https://news.example/update");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-detail-mobile.png", fullPage: true });
    await page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByLabel("搜索情报", { exact: true })).toHaveValue("使用条件");
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await page.getByRole("heading", { name: "角色一致性的方法" }).click();
    await expect(page.getByText("换镜头后怎么维持角色？", { exact: false })).toBeVisible();
    const replies = page.getByText("查看回复（1 条）", { exact: true });
    await replies.click();
    await expect(page.getByText("先固定参考图，再核对相邻镜头。", { exact: false })).toBeVisible();
    await expect(page.getByText("回复样本 1 条", { exact: false })).toBeVisible();
    await expect(page.getByText("尚未取得字幕或转写，当前仅有视频简介。", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: ".impeccable/review/intelligence-detail-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/comment-replies-mobile.png", fullPage: true });
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("补充参考弹窗批量去重、逐条报告失败，已有新闻直接复用且不自动新增关注", async () => {
  const page = await browser.newPage(); let newsPosts = 0, platformPosts = 0;
  const separator = adminHeaders.cookie.indexOf("="); await page.context().addCookies([{ name: adminHeaders.cookie.slice(0, separator), value: adminHeaders.cookie.slice(separator + 1), url: web.origin }]);
  page.on("request", request => { if (request.method() === "POST") { const path = new URL(request.url()).pathname; if (path === "/api/admin/studio/news-imports") newsPosts++; if (path === "/api/admin/studio/content-imports") platformPosts++; } });
  try {
    await page.goto(web.origin + "/admin/studio/intelligence");
    const sourceCount = (await app.inject({ url: "/api/admin/studio/news-sources", headers: adminHeaders })).json().total;
    const creatorCount = (await app.inject({ url: "/api/admin/studio/creators", headers: adminHeaders })).json().total;
    await page.getByRole("button", { name: "补充参考作品", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "补充参考作品", exact: true });
    await modal.getByLabel("批量参考链接").fill("https://www.bilibili.com/not-a-work\nhttps://news.example/update\nhttps://news.example/update");
    await modal.getByRole("button", { name: "读取并入库", exact: true }).click();
    await expect(modal.getByRole("button", { name: "查看内容", exact: true })).toHaveCount(1);
    await expect(modal.getByRole("button", { name: "重试这条", exact: true })).toHaveCount(1);
    assert.equal(newsPosts, 1); assert.equal(platformPosts, 1);
    await modal.getByRole("button", { name: "查看内容", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("heading", { name: "视频工具更新：角色参考和镜头控制", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "重试这条", exact: true }).click();
    await expect.poll(() => platformPosts).toBe(2); assert.equal(newsPosts, 1);
    assert.equal((await app.inject({ url: "/api/admin/studio/news-sources", headers: adminHeaders })).json().total, sourceCount);
    assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers: adminHeaders })).json().total, creatorCount);
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-bulk-import-390.png" });
  } finally { await page.close(); }
});

test("小红书补充失败后重试保留用户完整分享参数，不改成无法读取的规范地址", async () => {
  const page = await browser.newPage();
  const separator = adminHeaders.cookie.indexOf("="); await page.context().addCookies([{ name: adminHeaders.cookie.slice(0, separator), value: adminHeaders.cookie.slice(separator + 1), url: web.origin }]);
  const url = "https://www.xiaohongshu.com/explore/670000000000000001234567?xsec_token=fixture-retry-token&xsec_source=pc_feed";
  try {
    await page.clock.install(); await page.goto(web.origin + "/admin/studio/intelligence");
    await page.getByRole("button", { name: "补充参考作品", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "补充参考作品", exact: true });
    await modal.getByLabel("批量参考链接").fill(url);
    await modal.getByRole("button", { name: "读取并入库", exact: true }).click();
    await expect(modal.getByText("已排队", { exact: true })).toBeVisible();
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.content.import")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await assert.rejects(queue.run([job.data] as never[]), /单条作品未完成导入/); await boss.fail(queue.name, job.id);
    await page.clock.runFor(6000); await expect(modal.getByRole("button", { name: "重试这条", exact: true })).toBeVisible();
    const retried = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/studio/content-imports" && response.request().method() === "POST");
    await modal.getByRole("button", { name: "重试这条", exact: true }).click();
    const response = await retried; assert.equal(response.request().postDataJSON().url, url); assert.equal(response.status(), 200);
    await expect(modal.getByText("已排队", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("情报无匹配有清楚提示，详情接口失败可重新加载恢复且未执行来源HTML", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/intelligence?q=no-such-creation-topic");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "没有匹配的情报", exact: true })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/intelligence-empty-mobile.png", fullPage: true });
    await page.getByRole("link", { name: "重置", exact: true }).click();
    const first = page.getByRole("list", { name: "情报动态" }).getByRole("heading").first();
    const href = await first.locator("..").getAttribute("href"); assert.ok(href);
    detailUnavailable = true;
    await first.click();
    await expect(page.getByRole("dialog", { name: "情报详情" }).getByRole("alert")).toContainText("内容暂时无法读取");
    await page.screenshot({ path: ".impeccable/review/intelligence-error-mobile.png", fullPage: true });
    detailUnavailable = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("heading", { name: "情报详情", exact: true })).toBeVisible();
  } finally { detailUnavailable = false; await page.close(); }
});

test("来源正文按文字阅读，非HTTP原文地址不会成为可点击的执行链接", async () => {
  const material = await upsertMaterial({ sourceId: "intelligence-browser-news", title: "不可信地址样本", url: "javascript:alert(1)",
    via: "import", bodyStatus: "ok", bodyText: "<script>window.fixtureXSS=true</script>" });
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/intelligence/" + encodeURIComponent("news:" + material.articleId));
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "不可信地址样本", exact: true })).toBeVisible();
    await expect(page.getByText("原文地址暂不可用", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "打开原文或原作品", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate("Boolean(window.fixtureXSS)"), false);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  } finally { await page.close(); }
});

test("日期归档按年月日浏览并切换收录或发布口径，无发布日期可查，详情返回保留日期与搜索", async () => {
  for (const [title, collected, published] of [
    ["归档演示：午夜前", "2026-09-30T15:59:59Z", "2026-09-28T16:00:00Z"],
    ["归档演示：午夜后", "2026-09-30T16:00:00Z", "2026-09-30T16:00:00Z"],
    ["归档演示：未标发布日期", "2026-10-01T15:59:59Z", null],
  ] as const) await upsertMaterial({ sourceId: "intelligence-browser-news", title, url: `https://news.example/archive/${encodeURIComponent(title)}`, via: "import",
    discoveredAt: new Date(collected), publishedAt: published ? new Date(published) : null, bodyText: "归档内容保留原始来源。", bodyStatus: "ok" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.clock.install();
    await page.goto(web.origin + "/admin/studio/intelligence?view=archive&q=" + encodeURIComponent("归档演示"));
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("navigation", { name: "情报视图" }).getByRole("link", { name: "日期归档", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("list", { name: "情报动态" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByText("按收录日期归档 · 香港时间 · 2026-10-01", { exact: false })).toBeVisible();
    await page.bringToFront(); await page.waitForLoadState("networkidle");
    const polled = page.waitForResponse(response => response.url().includes("/api/admin/studio/intelligence?") && response.url().includes("limit=1"));
    await page.clock.runFor(31_000); await polled;
    await expect(page.getByRole("link", { name: /条新内容，点击加载/ })).toHaveCount(0);
    for (const [width, suffix] of [[1440, "desktop"], [1024, "tablet"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `.impeccable/review/intelligence-archive-${suffix}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await page.getByRole("complementary", { name: "情报日期导航" }).getByRole("link", { name: /^9 月/ }).click();
    await expect(page.getByRole("heading", { name: "归档演示：午夜前", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "情报动态" }).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("heading", { name: "归档演示：午夜前", exact: true }).click();
    await expect(page.getByRole("heading", { name: "情报详情", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByLabel("搜索情报", { exact: true })).toHaveValue("归档演示");
    await expect(page.getByText("按收录日期归档 · 香港时间 · 2026-09-30", { exact: false })).toBeVisible();
    await page.getByLabel("归档日期口径", { exact: true }).selectOption("published");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "归档演示：午夜后", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "未提供发布日期（1）", exact: true }).click();
    await expect(page.getByRole("heading", { name: "归档演示：未标发布日期", exact: true })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/intelligence-archive-undated-mobile.png", fullPage: true });
    await page.getByLabel("搜索情报", { exact: true }).fill("没有这篇归档情报");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有匹配的情报", exact: true })).toBeVisible();
    await expect(page.getByText("当前筛选没有可归档日期。", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/intelligence-archive-empty-mobile.png", fullPage: true });
    await page.getByRole("navigation", { name: "情报视图" }).getByRole("link", { name: "实时动态", exact: true }).click();
    await expect(page.getByLabel("归档日期口径", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

test("阅读中新增情报只提示而不插行，点击加载后显示；重复更新不新增，检查失败保留原列表并可恢复", async () => {
  const material = (suffix: string, body: string) => upsertMaterial({ sourceId: "intelligence-browser-news", title: "新增提醒测试" + suffix,
    url: "https://news.example/arrival/" + suffix, via: "import", bodyText: body, bodyStatus: "ok" });
  await material("A", "正在阅读的原有情报。");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.clock.install();
    async function poll(status: number) {
      const response = page.waitForResponse(response => response.url().includes("/api/admin/studio/intelligence?"));
      await page.clock.runFor(31_000); assert.equal((await response).status(), status);
      await page.waitForLoadState("networkidle");
    }
    await page.goto(web.origin + "/admin/studio/intelligence?q=" + encodeURIComponent("新增提醒测试"));
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const rows = page.getByRole("list", { name: "情报动态" }).getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await page.bringToFront(); await page.waitForLoadState("networkidle");
    await material("B", "刚刚采集的新材料。");
    await poll(200);
    const notice = page.getByRole("link", { name: "有 1 条新内容，点击加载", exact: true });
    await expect(notice).toBeVisible(); await expect(rows).toHaveCount(1);
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `.impeccable/review/intelligence-arrivals-${suffix}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await notice.click(); await expect(rows).toHaveCount(2); await expect(notice).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await material("B", "同一材料的正文更新，不是另一条作品。");
    await poll(200);
    await expect(notice).toHaveCount(0); await expect(rows).toHaveCount(2);
    await page.route("**/api/admin/studio/intelligence?*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
    await poll(503);
    await expect(page.getByText("新内容检查暂时失败，将自动重试。", { exact: true })).toBeVisible(); await expect(rows).toHaveCount(2);
    await page.screenshot({ path: ".impeccable/review/intelligence-arrivals-error-mobile.png", fullPage: true });
    await page.unroute("**/api/admin/studio/intelligence?*");
    await poll(200);
    await expect(page.getByText("新内容检查暂时失败，将自动重试。", { exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
  } finally { await page.close(); }
});

test("已保存的本地转写默认折叠，展开可读时间段与私有关键帧，桌面和手机仍能返回原作品", async () => {
  const headers = adminHeaders;
  const added = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } })).json().creator;
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${added.id}/collect`, headers, payload: {} }); bilibiliFixture(transport);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${added.id}/contents`, headers })).json().rows[0], url = "https://media.example/browser-evidence.mp4";
  transport.get("https://media.example").intercept({ path: "/browser-evidence.mp4" }).reply(200, "external-media-fixture");
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#236058" } }).png().toBuffer();
  await createMediaTranscriptionProcessor({ resolve: async () => ({ url, kind: "video" }), recognize: async () => ({ language: "zh", durationSeconds: 12, model: "external-browser-asr-fixture",
    segments: [{ start: 0, end: 5, text: "先固定角色参考图，再逐镜检查光线。" }, { start: 5, end: 12, text: "确认转写与必要画面保存后，再清理原视频。" }],
    frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }, { timeSeconds: 10, pngBase64: png.toString("base64") }] }) }).process(post.id);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/creator%3A${post.id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const details = page.locator(".studio-transcript details"); await expect(details).not.toHaveAttribute("open", "");
    await page.getByText("展开完整转写与关键帧（2 段）", { exact: true }).click();
    await expect(page.getByText("先固定角色参考图，再逐镜检查光线。", { exact: true })).toBeVisible();
    await expect(page.getByText("原媒体已清理", { exact: false })).toBeVisible();
    await expect(page.getByText("已保存少量关键帧，尚未完成画面与节奏分析。", { exact: false })).toBeVisible();
    await expect(page.getByText("该记录尚无本地节奏观察；不能从转写断句推算停顿或切镜。", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "打开原文或原作品", exact: true })).toHaveAttribute("href", "https://www.bilibili.com/video/BV1fixture");
    await expect.poll(() => page.locator(".studio-keyframes img").evaluateAll(images => images.every(image => (image as unknown as { naturalWidth: number }).naturalWidth === 320))).toBe(true);
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/intelligence-transcript-${suffix}.png`, fullPage: true });
    }
    await page.getByText("展开完整转写与关键帧（2 段）", { exact: true }).click(); await expect(details).not.toHaveAttribute("open", "");
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("视频详情可提交独立处理任务，显示排队状态，完成后自动呈现正文且桌面和窄屏保持可读", async () => {
  const headers = adminHeaders;
  const added = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } })).json().creator;
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${added.id}/collect`, headers, payload: {} }); weiboFixture(transport, { complete: true, video: true });
  const collecting = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss(), [job] = await boss.fetch(collecting.name); assert.ok(job);
  await collecting.run([job.data] as never[]); await boss.complete(collecting.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${added.id}/contents`, headers })).json().rows[0];
  const previousEnabled = process.env.STUDIO_MEDIA_ENABLED; process.env.STUDIO_MEDIA_ENABLED = "true";
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.clock.install();
    await page.goto(web.origin + `/admin/studio/intelligence/creator%3A${post.id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByText("视频尚未排队处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "处理视频", exact: true }).click();
    await expect(page.getByText("视频已排队，等待处理", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "处理视频", exact: true })).toHaveCount(0);
    await page.screenshot({ path: ".impeccable/review/intelligence-media-queued-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1100 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-media-queued-mobile.png", fullPage: true });
    const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#3e6157" } }).png().toBuffer();
    const { createMediaProcessingQueue } = await import("../backend/media-jobs.ts");
    const queue = createMediaProcessingQueue({ recognize: async () => ({ language: "zh", durationSeconds: 8, model: "external-browser-asr-fixture",
      segments: [{ start: 0, end: 8, text: "同一个详情页自动显示已经完成的转写结果。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }) });
    const [mediaJob] = await boss.fetch(queue.name); assert.ok(mediaJob);
    weiboVideoDetailFixture(transport);
    transport.get("https://f.video.weibocdn.com").intercept({ path: "/fixture-video.mp4" }).reply(200, "external-queued-video");
    await queue.run([mediaJob.data] as never[]); await boss.complete(queue.name, mediaJob.id);
    await page.bringToFront(); await page.clock.runFor(6000);
    await expect(page.getByRole("heading", { name: "本地转写与画面证据", exact: true })).toBeVisible();
    await page.getByText("展开完整转写与关键帧（1 段）", { exact: true }).click();
    await expect(page.getByText("同一个详情页自动显示已经完成的转写结果。", { exact: true })).toBeVisible();
    await page.clock.runFor(1000);
    await expect(page.getByText("视频已提交处理", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: ".impeccable/review/intelligence-media-ready-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); if (previousEnabled === undefined) delete process.env.STUDIO_MEDIA_ENABLED; else process.env.STUDIO_MEDIA_ENABLED = previousEnabled; }
});

test("节奏观察默认精简，桌面和手机可独立展开方法与真实时点，不将低能量或采样变化当作停顿切镜", async () => {
  const headers = adminHeaders;
  const creator = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } })).json().creator;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport, { description: "从角色参考到连续镜头，核对开头和演示节奏。" });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows[0];
  transport.get("https://media.example").intercept({ path: "/browser-rhythm.mkv" }).reply(200, "external-rhythm-fixture");
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#236058" } }).png().toBuffer();
  await createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/browser-rhythm.mkv", kind: "video" }),
    recognize: async () => ({ language: "zh", durationSeconds: 8, model: "external-browser-rhythm-fixture", segments: [{ start: 0, end: 6, text: "先看角色参考，再看连续镜头的制作步骤。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }],
      rhythm: { version: 1, audio: { method: "rms_20ms_v1", timeBasis: "decoded_audio", observedSeconds: 6, quietThresholdDbfs: -40, minimumQuietSeconds: 0.3,
        quietSeconds: 1.0111, quietIntervalCount: 1, quietIntervals: [{ start: 1.0234, end: 2.0345 }], truncated: false, windows: [{ start: 0, end: 6, rmsDbfs: -20, quietFraction: 0.1685 }] },
        visual: { method: "sampled_rgb_v1", timeBasis: "video_elapsed", sampleIntervalSeconds: 0.5, changeThreshold: 0.18, sampleCount: 16, sampledUntilSeconds: 7.5,
          changeCount: 3, changeTimes: [2, 4, 6], truncated: false, windows: [{ start: 0, end: 8, samples: 16, changes: 3 }] } } }) }).process(post.id);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/creator%3A${post.id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const rhythm = page.getByLabel("本地节奏观察", { exact: true }), methods = page.getByLabel("节奏方法与时间记录", { exact: true });
    await expect(rhythm).toContainText("音轨观测 6 秒 · 低能量 1 处，共 1.01 秒");
    await expect(rhythm).toContainText("画面采样 16 次，至 7.5 秒 · 采样变化 3 次");
    await expect(methods).not.toHaveAttribute("open", "");
    await expect(page.locator(".studio-transcript > details")).not.toHaveAttribute("open", "");
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      await page.screenshot({ path: `.impeccable/review/intelligence-rhythm-${suffix}.png`, fullPage: true });
      await methods.locator("summary").click();
      await expect(methods).toContainText("低能量不等于说话停顿"); await expect(methods).toContainText("采样变化不等于精确切镜");
      await expect(methods).toContainText("1.02 秒–2.03 秒"); await expect(methods).toContainText("变化时间：2 秒；4 秒；6 秒");
      await expect(page.locator(".studio-transcript > details")).not.toHaveAttribute("open", "");
      await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/intelligence-rhythm-expanded-${suffix}.png`, fullPage: true });
      await methods.locator("summary").click();
    }
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});


