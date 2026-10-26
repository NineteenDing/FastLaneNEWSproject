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
  config.adminPassword = "studio-region-browser-password";
  config.siteUrl = "http://127.0.0.1";
  await app.ready();
  web = await startWebServer(app.server);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("地区筛选可与关键词组合，翻页保留地区，待补充与清空结果均可重置", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    for (let n = 0; n < 26; n++) {
      const id = `region-browser-${n}`;
      assert.equal((await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
        data: { id, name: `地区浏览器 ${String(n).padStart(2, "0")}`, kind: "rss", config: { feedUrl: `https://region-browser.example/${n}` } } })).status(), 200);
      if (n < 25) assert.equal((await page.request.put(web.origin + `/api/admin/studio/news-sources/${id}/profile`, { headers: { "x-csrf-token": me.csrf },
        data: { version: 0, region: "中国", description: "用于验证地区筛选的隔离测试来源", language: "中文", homepage: null } })).status(), 200);
    }
    await page.reload();
    const select = page.getByRole("combobox", { name: "服务地区", exact: true });
    await expect(select).toBeVisible({ timeout: 3000 });
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("地区浏览器");
    await select.selectOption({ label: "中国（25）" });
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("25 个来源", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
    await expect(select).toHaveValue("region:中国");
    await expect(page.getByRole("article")).toHaveCount(1);
    await mkdir(".impeccable/review/region", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/region/selected-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    await select.selectOption("missing");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "地区浏览器 25", exact: true })).toBeVisible();
    await expect(page.getByText("1 个来源", { exact: true })).toBeVisible();
    await select.selectOption("region:中国");
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("找不到的地区来源");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有匹配的新闻源" })).toBeVisible();
    await expect(select).toHaveValue("region:中国");
    await expect(select.getByRole("option", { name: "中国（0）", exact: true })).toBeAttached();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `.impeccable/review/region/empty-${width}.png`, fullPage: true });
    }
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await expect(select).toHaveValue("");
    await expect(page.getByRole("searchbox", { name: "搜索新闻源" })).toHaveValue("");
  } finally { await page.close(); }
});

test("字面地区名null与未填写地区分开，零结果下仍保留正确选择", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    for (const [id, name, region] of [["literal-region", "字面地区有资料", "null"], ["missing-region", "字面地区无资料", null]] as const) {
      assert.equal((await page.request.post(web.origin + "/api/admin/sources", { headers: { "x-csrf-token": me.csrf },
        data: { id, name, kind: "rss", config: { feedUrl: `https://region-browser.example/${id}` } } })).status(), 200);
      if (region) assert.equal((await page.request.put(web.origin + `/api/admin/studio/news-sources/${id}/profile`, { headers: { "x-csrf-token": me.csrf },
        data: { version: 0, region, description: null, language: null, homepage: null } })).status(), 200);
    }
    await page.reload();
    const select = page.getByRole("combobox", { name: "服务地区", exact: true });
    await select.selectOption("region:null");
    await page.getByRole("searchbox", { name: "搜索新闻源" }).fill("字面地区无资料");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有匹配的新闻源" })).toBeVisible();
    await expect(select).toHaveValue("region:null", { timeout: 3000 });
    await expect(select.getByRole("option", { name: "null（0）", exact: true })).toBeAttached();
    await select.selectOption("missing");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("article", { name: "字面地区无资料", exact: true })).toBeVisible();
  } finally { await page.close(); }
});

