import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
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
let browser: Browser, web: WebServer;
before(async () => {
  config.adminPassword = "platform-session-browser-password"; config.siteUrl = "http://127.0.0.1";
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("设置页可分别保存七平台会话，保存后不回显，旧窗口不能覆盖，清除保留内容边界", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), page = await context.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("link", { name: "平台登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "平台登录", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "设置", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "关注管理", exact: true })).not.toHaveAttribute("aria-current", "page");
    const xhs = page.getByRole("region", { name: "小红书登录设置", exact: true, includeHidden: true }), weibo = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true });
    await inSettingsSection(page, "platforms", () => weibo.getByLabel("登录信息（Cookie）", { exact: true }).fill("SUB=private-independent-draft"));
    await xhs.getByLabel("登录信息（Cookie）", { exact: true }).fill("a1=private-browser-cookie; web_session=private-browser-session");
    await xhs.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(xhs.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await expect(xhs.getByLabel("登录信息（Cookie）", { exact: true })).toHaveValue("");
    await expect(weibo.getByLabel("登录信息（Cookie）", { exact: true })).toHaveValue("SUB=private-independent-draft");
    await inSettingsSection(page, "platforms", () => weibo.getByLabel("登录信息（Cookie）", { exact: true }).fill(""));
    assert.ok(!(await page.content()).includes("private-browser-cookie"));
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 8000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/platform-settings-desktop.png", fullPage: true });
    const stale = await page.context().newPage();
    try {
      await stale.goto(web.origin + "/admin/studio/settings/platforms");
      page.once("dialog", dialog => dialog.accept()); await xhs.getByRole("button", { name: "清除登录信息", exact: true }).click();
      await expect(xhs.getByText("尚未保存登录信息", { exact: true })).toBeVisible();
      const old = stale.getByRole("region", { name: "小红书登录设置", exact: true, includeHidden: true });
      await old.getByLabel("登录信息（Cookie）", { exact: true }).fill("a1=private-stale-window");
      await old.getByRole("button", { name: "保存登录信息", exact: true }).click();
      await expect(stale.getByRole("status").filter({ hasText: "平台会话已在其他窗口修改" })).toBeVisible();
      await expect(old.getByLabel("登录信息（Cookie）", { exact: true })).toHaveValue("a1=private-stale-window");
    } finally { await stale.close(); }
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await expect(page.getByRole("heading", { name: "关注管理", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("窄屏会话表单失败保留输入，可清空修改，不横向溢出", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/platforms");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const region = page.getByRole("region", { name: "小红书登录设置", exact: true, includeHidden: true });
    await region.getByLabel("登录信息（Cookie）", { exact: true }).fill("Cookie: a1=wrong-header");
    await region.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "请粘贴Cookie值" })).toBeVisible();
    await expect(region.getByLabel("登录信息（Cookie）", { exact: true })).toHaveValue("Cookie: a1=wrong-header");
    await expect(page.getByRole("status").locator(":scope > div")).toHaveCSS("opacity", "1");
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/platform-settings-mobile-error.png", fullPage: true });
    await region.getByLabel("登录信息（Cookie）", { exact: true }).fill("");
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 10000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/platform-settings-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
  } finally { await page.close(); }
});
