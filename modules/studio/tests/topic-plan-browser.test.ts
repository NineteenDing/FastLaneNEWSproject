import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect, type Browser } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
let browser: Browser, web: WebServer;
before(async () => {
  config.siteUrl = "http://127.0.0.1";
  await resources.warm(); web = await startWebServer(app.server); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await closeDb(); });

test("设置页保存两日计划与Cookie草稿互不覆盖，旧页面冲突保留输入，已有历史显示锁定原因", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/topics");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const plan = page.getByRole("region", { name: "两日选题计划", exact: true });
    await expect(plan.getByRole("heading", { name: "自动截止已关闭", exact: true })).toBeVisible();
    await expect(plan.getByLabel("首批开始时间（香港时间）", { exact: true })).toHaveValue("2026-10-16T20:00");
    const cookie = page.getByRole("region", { name: "小红书登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true });
    await inSettingsSection(page, "platforms", () => cookie.fill("a1=private-unsaved-plan-independent"));
    await plan.getByLabel("首批开始时间（香港时间）", { exact: true }).fill("2026-10-10T18:00");
    await plan.getByLabel("启用自动截止", { exact: true }).check();
    await plan.getByRole("button", { name: "保存选题计划", exact: true }).click();
    await expect(plan.getByRole("heading", { name: "自动截止已开启", exact: true })).toBeVisible();
    await expect(cookie).toHaveValue("a1=private-unsaved-plan-independent");
    await inSettingsSection(page, "platforms", () => cookie.fill(""));
    const read = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
    assert.equal(read.startsAt, "2026-10-10T10:00:00.000Z"); assert.equal(read.version, 1);
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 10000 });
    await page.evaluate("window.scrollTo(0,0)");
    await page.screenshot({ path: ".impeccable/review/topic-plan-desktop.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
      payload: { version: 1, enabled: false, startsAt: read.startsAt } })).statusCode, 200);
    await plan.getByLabel("首批开始时间（香港时间）", { exact: true }).fill("2026-10-11T19:00");
    await plan.getByRole("button", { name: "保存选题计划", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "选题计划已在其他窗口修改" })).toBeVisible();
    await expect(plan.getByLabel("首批开始时间（香港时间）", { exact: true })).toHaveValue("2026-10-11T19:00");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate("window.scrollTo(0,0)");
    await page.screenshot({ path: ".impeccable/review/topic-plan-mobile-conflict.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: read.startsAt } });
    assert.equal(frozen.statusCode, 200);
    await page.reload();
    await expect(plan.getByLabel("首批开始时间（香港时间）", { exact: true })).toBeDisabled();
    await expect(plan.getByText(/已有历史批次，当前版本锁定时间边界/)).toBeVisible();
    await plan.getByLabel("启用自动截止", { exact: true }).check();
    await plan.getByRole("button", { name: "保存选题计划", exact: true }).click();
    await expect(plan.getByRole("heading", { name: "自动截止已开启", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 10000 });
    await page.evaluate("window.scrollTo(0,0)");
    await page.screenshot({ path: ".impeccable/review/topic-plan-mobile-locked.png", fullPage: true });
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.evaluate("window.scrollTo(0,0)");
    await page.screenshot({ path: ".impeccable/review/topic-plan-tablet.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await plan.getByRole("link", { name: "查看当期与历史", exact: true }).click();
    await expect(page.getByRole("heading", { name: "当期选题", exact: true })).toBeVisible();
  } finally { await page.close(); }
});
