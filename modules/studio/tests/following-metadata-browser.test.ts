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
const previous = getGlobalDispatcher();
const transport = new MockAgent();
transport.disableNetConnect();
transport.enableNetConnect(host => host.startsWith("127.0.0.1:") || host.startsWith("localhost:"));
before(async () => {
  config.adminPassword = "studio-metadata-browser-password";
  config.siteUrl = "http://127.0.0.1";
  config.allowPrivateNetworkFetch = true;
  setGlobalDispatcher(transport);
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("关注页补全来源资料与本地头像，缺主页明确提示，头像加载失败回到名称占位", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    for (const [id, name, kind, sourceConfig] of [
      ["browser-metadata", "测试影视站", "web_list", { url: "https://metadata-browser.example/news", itemSelector: "article" }],
      ["browser-no-home", "主页待填写的桥接来源", "external", {}],
    ] as const) assert.equal((await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
      data: { id, name, kind, config: sourceConfig } })).status(), 200);
    transport.get("https://metadata-browser.example").intercept({ path: "/news" })
      .reply(200, '<html lang="zh-CN"><head><meta name="description" content="专注影视创作工具与制作方法"><link rel="icon" href="/icon.svg"></head></html>').delay(250);
    transport.get("https://metadata-browser.example").intercept({ path: "/icon.svg" })
      .reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#216560"/><path d="M20 16h28v8H28v12h16v8H28v12h-8z" fill="white"/></svg>', { headers: { "content-type": "image/svg+xml" } });
    await page.goto(web.origin + "/admin/studio/following?q=browser-metadata");
    const card = page.getByRole("article", { name: "测试影视站", exact: true });
    const refresh = card.getByRole("button", { name: "补全资料与头像", exact: true });
    await expect(refresh).toBeVisible({ timeout: 3000 });
    await refresh.click();
    await expect(card.getByRole("button", { name: "正在补全…", exact: true })).toBeDisabled();
    await expect(card.getByText("专注影视创作工具与制作方法", { exact: true })).toBeVisible();
    await expect(card.getByText("zh-CN", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "打开测试影视站主页", exact: true })).toHaveAttribute("href", "https://metadata-browser.example/news");
    const avatar = card.locator("header img");
    await expect(avatar).toHaveAttribute("src", /^\/api\/admin\/studio\/news-sources\/browser-metadata\/avatar\?v=/);
    await expect.poll(() => avatar.evaluate(element => (element as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    await page.reload();
    await expect.poll(() => avatar.evaluate(element => (element as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    await mkdir(".impeccable/review/metadata", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/metadata/ready-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    transport.get("https://metadata-browser.example").intercept({ path: "/news" })
      .reply(200, '<html lang="zh-CN"><head><meta name="description" content="专注影视创作工具与制作方法"><link rel="icon" href="/icon.svg"></head></html>');
    transport.get("https://metadata-browser.example").intercept({ path: "/icon.svg" }).reply(503, "temporarily unavailable");
    transport.get("https://metadata-browser.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
    await refresh.click();
    await expect(card.getByRole("definition").filter({ hasText: "资料已更新 · 头像读取失败" })).toBeVisible();
    await page.reload();
    await expect.poll(() => avatar.evaluate(element => (element as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/metadata/retained-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/avatar?v=*", route => route.fulfill({ status: 404, body: "missing" }));
    await page.route("**/*.js", async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
    await page.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("header img")).toHaveCount(0);
    await expect(card.locator("header .studio-avatar")).toHaveText("测试");
    await page.goto(web.origin + "/admin/studio/following?q=browser-no-home");
    const missing = page.getByRole("article", { name: "主页待填写的桥接来源", exact: true });
    await missing.getByRole("button", { name: "补全资料与头像", exact: true }).click();
    await expect(missing.getByRole("definition").filter({ hasText: "请补充公开主页" })).toBeVisible();
    await page.reload();
    await expect(missing.getByRole("definition").filter({ hasText: "请补充公开主页" })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/metadata/needs-home-${width}.png`, fullPage: true });
    }
    assert.ok(requests.every(url => url.startsWith(web.origin)), "浏览器仅请求本地服务，不直连来源或图标站");
  } finally { await page.close(); }
});
