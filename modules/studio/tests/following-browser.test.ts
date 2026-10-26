import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
let web: WebServer;
let browser: Browser;
before(async () => {
  config.adminPassword = "studio-browser-test-password";
  config.siteUrl = "http://127.0.0.1";
  await app.ready();
  web = await startWebServer(app.server);
  browser = await chromium.launch();
});

test("窄屏筛选为空后可重置；资料冲突会保留正在编辑的内容", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("不存在的来源");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有匹配的新闻源" })).toBeVisible();
    await page.getByRole("link", { name: "重置" }).click();
    await expect(page.getByRole("searchbox", { name: "搜索新闻源" })).toHaveValue("");
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    const created = await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
      data: { id: "conflict-news", name: "多窗口资料", kind: "rss", config: { feedUrl: "https://example.com/conflict.xml" } } });
    assert.equal(created.status(), 200);
    await page.reload();
    const card = page.getByRole("article", { name: "多窗口资料" });
    await card.getByRole("button", { name: "编辑资料" }).click();
    await page.getByLabel("简介", { exact: true }).fill("这个窗口尚未保存的内容");
    const source = (await (await page.request.get(web.origin + "/api/admin/studio/news-sources?q=conflict-news")).json()).rows[0];
    const saved = await page.request.put(web.origin + "/api/admin/studio/news-sources/conflict-news/profile", {
      headers: { "x-csrf-token": me.csrf }, data: { version: source.profileVersion, description: "另一个窗口的新内容", region: null, language: null, homepage: null },
    });
    assert.equal(saved.status(), 200);
    await page.getByRole("button", { name: "保存资料" }).click();
    await expect(page.getByText("资料已被其他窗口修改，请刷新后再编辑", { exact: true })).toBeVisible();
    await expect(page.getByLabel("简介", { exact: true })).toHaveValue("这个窗口尚未保存的内容");
  } finally { await page.close(); }
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("热榜第三栏可一次启用百度、读取榜单并暂停，小红书不伪装已适配", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/trends");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("navigation", { name: "关注类型" }).getByRole("link")).toHaveCount(3);
    const card = page.getByRole("article", { name: "百度热搜", exact: true });
    const toggle = card.getByRole("switch", { name: "启用百度热搜" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await card.getByRole("button", { name: "查看完整榜单", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("暂无已保存榜单，启用后等待后台检查。", { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("article", { name: "小红书热榜" }).getByRole("switch")).toBeDisabled();
    await page.reload(); await expect(toggle).toHaveAttribute("aria-checked", "false");
  } finally { await page.close(); }
});

test("从工作台新增RSS并修改采集设置，每次试读保存后返回原来源", async () => {
  const page = await browser.newPage();
  const previous = getGlobalDispatcher();
  const previousPrivate = config.allowPrivateNetworkFetch;
  const transport = new MockAgent();
  transport.disableNetConnect();
  transport.enableNetConnect(host => host.startsWith("127.0.0.1:") || host.startsWith("localhost:"));
  transport.get("https://browser-source.example").intercept({ path: "/feed" })
    .reply(200, '<rss version="2.0"><channel><title>新来源</title><item><title>动作控制更新</title><link>https://browser-source.example/news/1</link></item></channel></rss>');
  transport.get("https://browser-source.example").intercept({ path: "/edited" })
    .reply(200, '<rss version="2.0"><channel><title>修改的来源</title><item><title>镜头更新</title><link>https://browser-source.example/news/2</link></item></channel></rss>');
  setGlobalDispatcher(transport);
  config.allowPrivateNetworkFetch = true;
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await page.getByRole("link", { name: "添加新闻源", exact: true }).click();
    await expect(page.getByRole("heading", { name: "添加新闻源", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作台导航" })).toBeVisible();
    await page.getByLabel("来源名称", { exact: true }).fill("浏览器新增新闻");
    await page.getByLabel("采集地址", { exact: true }).fill("https://browser-source.example/feed");
    await mkdir(".impeccable/review/news-setup", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.screenshot({ path: `.impeccable/review/news-setup/new-${width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "验证并保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const card = page.getByRole("article", { name: "浏览器新增新闻" });
    await expect(card).toBeVisible();
    await expect(card.getByText("试读正常 · 1 条", { exact: true })).toBeVisible();
    await expect(card.getByText("已暂停", { exact: true })).toBeVisible();
    await expect(card.getByText("0 条", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.getByRole("navigation", { name: /来源设置.*分类/ }).getByRole("button", { name: "采集设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "采集设置", exact: true })).toBeVisible();
    await expect(page.getByLabel("采集地址", { exact: true })).toHaveValue("https://browser-source.example/feed");
    await page.reload();
    await card.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.getByRole("navigation", { name: /来源设置.*分类/ }).getByRole("button", { name: "采集设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "采集设置", exact: true })).toBeVisible();
    await page.getByLabel("来源名称", { exact: true }).fill("浏览器修改新闻");
    await page.getByLabel("采集地址", { exact: true }).fill("https://browser-source.example/edited");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.screenshot({ path: `.impeccable/review/news-setup/edit-${width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "验证并保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const changed = page.getByRole("article", { name: "浏览器修改新闻" });
    await expect(changed.getByText("试读正常 · 1 条", { exact: true })).toBeVisible();
    await expect(changed.getByText("已暂停", { exact: true })).toBeVisible();
  } finally { config.allowPrivateNetworkFetch = previousPrivate; setGlobalDispatcher(previous); await transport.close(); await page.close(); }
});

test("在窄屏移除来源后可从已移除列表恢复，原资料仍在且先保持暂停", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    const created = await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
      data: { id: "browser-archive", name: "可恢复新闻源", kind: "rss", config: { feedUrl: "https://example.com/archive.xml" } } });
    assert.equal(created.status(), 200);
    const profile = await page.request.put(web.origin + "/api/admin/studio/news-sources/browser-archive/profile", {
      headers: { "x-csrf-token": me.csrf }, data: { version: 0, description: "恢复后保留的来源简介", region: "中国", language: "简体中文", homepage: null },
    });
    assert.equal(profile.status(), 200);
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("可恢复新闻源");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const card = page.getByRole("article", { name: "可恢复新闻源" });
    await expect(card).toBeVisible();
    page.once("dialog", async dialog => { assert.match(dialog.message(), /保留历史材料/); await dialog.accept(); });
    await card.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.getByRole("navigation", { name: /来源设置.*分类/ }).getByRole("button", { name: "移除来源", exact: true }).click();
    await page.getByRole("region", { name: "移除来源", exact: true }).getByRole("button", { name: "移除来源", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel("显示范围", { exact: true }).selectOption("true");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(card.getByText("已移除", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "恢复到关注列表" })).toBeVisible();
    await page.reload();
    await expect(card).toBeVisible();
    await mkdir(".impeccable/review/archive", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.screenshot({ path: `.impeccable/review/archive/removed-${width}.png`, fullPage: true });
    }
    assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth > innerWidth"), false);
    await card.getByRole("button", { name: "恢复到关注列表" }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel("显示范围", { exact: true }).selectOption("false");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(card.getByText("已暂停", { exact: true })).toBeVisible();
    await expect(card.getByText("恢复后保留的来源简介", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "启用关注" }).click();
    await expect(card.getByText("尚未检查", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("先前来源的保存响应迟到时，不关闭后来打开的资料编辑器", async () => {
  const page = await browser.newPage();
  let release: (() => void) | undefined;
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    for (const [id, name] of [["slow-news-a", "异步来源A"], ["slow-news-b", "异步来源B"]]) {
      const created = await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
        data: { id, name, kind: "rss", config: { feedUrl: `https://example.com/${id}.xml` } } });
      assert.equal(created.status(), 200);
    }
    await page.reload();
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const saving = new Promise<void>(resolve => { started = resolve; });
    await page.route("**/api/admin/studio/news-sources/slow-news-a/profile", async route => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole("article", { name: "异步来源A" }).getByRole("button", { name: "编辑资料" }).click();
    await page.getByLabel("简介", { exact: true }).fill("来源A的保存内容");
    await page.getByRole("button", { name: "保存资料" }).click();
    await saving;
    await page.keyboard.press("Escape");
    await page.getByRole("article", { name: "异步来源B" }).getByRole("button", { name: "编辑资料" }).click();
    await page.getByLabel("简介", { exact: true }).fill("来源B尚未保存的内容");
    release!();
    await expect(page.getByText("资料已保存", { exact: true })).toBeVisible();
    await expect(page.getByLabel("简介", { exact: true })).toHaveValue("来源B尚未保存的内容");
    await expect(page.getByRole("region", { name: "编辑异步来源B资料" })).toBeVisible();
  } finally { release?.(); await page.close(); }
});

test("登录后在关注页搜索新闻源，编辑资料并暂停恢复，重新打开仍保留", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page).toHaveTitle("登录 · FastLaneNEWS 后台");
    await expect(page.getByRole("img", { name: "FastLaneNEWS", exact: true })).toBeVisible();
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("关注管理 · FastLaneNEWS");
    await expect(page.getByText("FastLaneNEWS", { exact: true })).toBeVisible();
    const me = await page.request.get(web.origin + "/api/admin/me");
    const csrf = (await me.json()).csrf;
    const created = await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": csrf },
      data: { id: "browser-news", name: "创作者工具日报", kind: "rss", config: { feedUrl: "https://example.com/rss" } } });
    assert.equal(created.status(), 200);
    await page.reload();
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("创作者");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const card = page.getByRole("article", { name: "创作者工具日报" });
    await expect(card).toBeVisible();
    await expect(card.getByText("地区待补充", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "编辑资料" }).click();
    await page.getByLabel("简介", { exact: true }).fill("视频工具与制作流程更新");
    await page.getByLabel("主要服务地区").fill("中国");
    await page.getByLabel("内容语言").fill("简体中文");
    await page.getByLabel("来源主页").fill("https://example.com/news");
    await page.getByRole("button", { name: "保存资料" }).click();
    await expect(card.getByText("视频工具与制作流程更新")).toBeVisible();
    await card.getByRole("button", { name: "暂停关注" }).click();
    await expect(card.getByText("已暂停", { exact: true })).toBeVisible();
    await page.reload();
    await expect(card.getByText("中国", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "打开创作者工具日报主页" })).toHaveAttribute("href", "https://example.com/news");
    await card.getByRole("button", { name: "启用关注" }).click();
    await expect(card.getByText("尚未检查", { exact: true })).toBeVisible();
    const response = await page.request.get(web.origin + "/admin/studio/following");
    assert.match(response.headers()["cache-control"]!, /no-store/);
  } finally { await page.close(); }
});
