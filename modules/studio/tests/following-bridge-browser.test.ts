import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
  config.adminPassword = "studio-bridge-browser-password";
  config.siteUrl = "http://127.0.0.1";
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("外部来源从卡片编辑桥接，原路由可见，保存暂停并返回原卡片，冲突保留输入", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    const created = await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
      data: { id: "src-qwen-blog", name: "千问桥接测试来源", kind: "external", config: {} } });
    assert.equal(created.status(), 200);
    await page.goto(web.origin + "/admin/studio/following?q=src-qwen-blog");
    const card = page.getByRole("article", { name: "千问桥接测试来源", exact: true });
    await card.getByRole("link", { name: "桥接设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "桥接设置", exact: true })).toBeVisible();
    await expect(page.getByLabel("RSSHub 路由", { exact: true })).toHaveValue("/qwen/blog");
    await expect(page.getByText("RSSHub 运行服务尚未配置", { exact: true })).toBeVisible();
    await mkdir(".impeccable/review/bridge", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/bridge/edit-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    await page.getByLabel("来源名称", { exact: true }).fill("桥接改名后");
    await page.getByLabel("每次处理上限", { exact: true }).fill("12");
    await page.getByRole("button", { name: "保存并暂停", exact: true }).click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const saved = page.getByRole("article", { name: "桥接改名后", exact: true });
    await expect(saved.locator(".studio-status")).toHaveText("已暂停");
    await saved.getByRole("link", { name: "桥接设置", exact: true }).click();
    await expect(page.getByLabel("每次处理上限", { exact: true })).toHaveValue("12");
    const settings = await (await page.request.get(web.origin + "/api/admin/studio/news-sources/src-qwen-blog/bridge")).json();
    const updated = await page.request.put(web.origin + "/api/admin/studio/news-sources/src-qwen-blog/bridge", {
      headers: { "x-csrf-token": me.csrf }, data: { version: settings.version, name: "另一个窗口", route: "/qwen/blog", itemLimit: 8, aiFilter: false } });
    assert.equal(updated.status(), 200);
    await page.getByLabel("来源名称", { exact: true }).fill("这个窗口尚未保存");
    await page.getByRole("button", { name: "保存并暂停", exact: true }).click();
    await expect(page.getByText("信源已被其他操作修改，请刷新后再改", { exact: true })).toBeVisible();
    await expect(page.getByLabel("来源名称", { exact: true })).toHaveValue("这个窗口尚未保存");
  } finally { await page.close(); }
});

test("桥接地址配置不冒充服务已连接，配置无效仍可编辑来源", async () => {
  const previous = process.env.STUDIO_RSSHUB_BASE_URL;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    process.env.STUDIO_RSSHUB_BASE_URL = "http://127.0.0.1:1200";
    await page.goto(web.origin + "/admin/studio/news-sources/src-qwen-blog/bridge");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText("RSSHub 地址已配置，连接状态待验证", { exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/bridge/configured-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    process.env.STUDIO_RSSHUB_BASE_URL = "https://foreign.example";
    await page.reload();
    await expect(page.getByText("RSSHub 地址配置无效", { exact: true })).toBeVisible();
    await expect(page.getByLabel("来源名称", { exact: true })).toBeEnabled();
  } finally {
    if (previous === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = previous;
    await page.close();
  }
});
