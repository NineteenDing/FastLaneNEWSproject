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
import { chatJson } from "@aihot/backend/providers/llm";
import { z } from "zod";
import { stub } from "../../../tests/setup.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
let browser: Browser, web: WebServer;
before(async () => {
  config.adminPassword = "model-connection-browser-password"; config.siteUrl = "http://127.0.0.1";
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("费用按用途显示，刷新失败保留数据和未保存输入，桌面与窄屏可读", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "usage-browser-key", LLM_MODEL: "usage-browser-model" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await chatJson({ model: "default", purpose: "studio_writing_draft", subject: "browser-usage", promptVersion: "browser-usage-v1",
      system: "用量验证", user: "本地费用样本", schema: z.object({ ok: z.literal(true) }), maxTokens: 2000 });
    await page.goto(web.origin + "/admin/studio/settings/models");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const usage = page.getByRole("region", { name: "模型费用与用量", exact: true });
    await expect(usage.getByText("口播写作", { exact: true })).toBeVisible();
    await expect(usage.getByText("1,000 / 1,000", { exact: true })).toBeVisible();
    await expect(usage.getByText(/实际扣费以服务商账单为准/)).toBeVisible();
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/model-usage-desktop.png", fullPage: true });
    await usage.screenshot({ path: ".impeccable/review/model-usage-details-desktop.png" });
    const key = page.getByLabel("API Key", { exact: true }); await inSettingsSection(page, "models", () => key.fill("unsaved-usage-browser-key"));
    const cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true });
    await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-usage-browser-cookie"));
    await page.route(web.origin + "/api/admin/studio/model-usage", route => route.fulfill({ status: 503, body: "unavailable" }));
    await usage.getByRole("button", { name: "刷新用量", exact: true }).click();
    await expect(usage.getByRole("alert")).toContainText("已保留上次数据");
    await expect(key).toHaveValue("unsaved-usage-browser-key"); await expect(cookie).toHaveValue("SUB=unsaved-usage-browser-cookie");
    await expect(usage.getByText("1,000 / 1,000", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/model-usage-mobile-error.png", fullPage: true });
    await usage.screenshot({ path: ".impeccable/review/model-usage-details-mobile-error.png" });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.unroute(web.origin + "/api/admin/studio/model-usage");
    await usage.getByRole("button", { name: "刷新用量", exact: true }).click();
    await expect(usage.getByRole("alert")).toHaveCount(0);
    await expect(key).toHaveValue("unsaved-usage-browser-key"); assert.equal(provider.hits(), 1, "刷新与读取都不调用模型");
  } finally { await page.close(); await provider.close(); }
});

test("模型设置可保存和清除Key，与Cookie表单独立，旧窗口冲突保留输入，桌面与平板规整", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/settings/models");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const model = page.getByRole("region", { name: "模型服务", exact: true });
    await expect(model.getByLabel("Flash模型", { exact: true })).toHaveValue("deepseek-flash");
    await expect(model.getByLabel("Flash模型", { exact: true })).toHaveAttribute("readonly", "");
    const weibo = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true });
    await inSettingsSection(page, "platforms", () => weibo.getByLabel("登录信息（Cookie）", { exact: true }).fill("SUB=independent-unsaved-cookie"));
    await model.getByLabel("API Key", { exact: true }).fill("private-browser-model-key");
    await model.getByRole("button", { name: "保存模型连接", exact: true }).click();
    await expect(model.getByText("API Key已保存", { exact: false })).toBeVisible();
    await expect(model.getByLabel("API Key", { exact: true })).toHaveValue("");
    await expect(weibo.getByLabel("登录信息（Cookie）", { exact: true })).toHaveValue("SUB=independent-unsaved-cookie");
    assert.ok(!(await page.content()).includes("private-browser-model-key"));
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 8000 });
    await page.evaluate("window.scrollTo(0,0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/model-settings-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 1024, height: 1000 });
    await expect(model.getByRole("heading", { name: "兼容服务与费用估算", exact: true })).toBeVisible();
    await expect(model.getByLabel("Flash输出单价", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.evaluate("window.scrollTo(0,0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/model-settings-tablet-prices.png", fullPage: true });
    const stale = await context.newPage();
    try {
      await stale.goto(web.origin + "/admin/studio/settings/models");
      page.once("dialog", dialog => dialog.accept()); await model.getByRole("button", { name: "清除API Key", exact: true }).click();
      await expect(model.getByText("尚未保存API Key。", { exact: true })).toBeVisible();
      const oldModel = stale.getByRole("region", { name: "模型服务", exact: true });
      await oldModel.getByLabel("API Key", { exact: true }).fill("private-stale-browser-key");
      await oldModel.getByRole("button", { name: "保存模型连接", exact: true }).click();
      await expect(stale.getByRole("status").filter({ hasText: "模型连接已在其他窗口修改" })).toBeVisible();
      await expect(oldModel.getByLabel("API Key", { exact: true })).toHaveValue("private-stale-browser-key");
    } finally { await stale.close(); }
  } finally { await context.close(); }
});

test("模型任务可独立暂停恢复，不丢连接或Cookie输入，旧窗口冲突可见，未获启动许可时不能启用", async () => {
  const original = config.modelCallsEnabled;
  config.modelCallsEnabled = true;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/settings/models");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const model = page.getByRole("region", { name: "模型服务", exact: true });
    await model.getByLabel("API Key", { exact: true }).fill("unsaved-operations-key");
    const cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true });
    await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-operations-cookie"));
    await model.getByRole("button", { name: "暂停模型任务", exact: true }).click();
    await expect(model.getByText("模型任务：已暂停", { exact: true })).toBeVisible();
    await expect(model.getByLabel("API Key", { exact: true })).toHaveValue("unsaved-operations-key");
    await expect(cookie).toHaveValue("SUB=unsaved-operations-cookie");
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 8000 });
    await page.screenshot({ path: ".impeccable/review/model-operations-paused-desktop.png", fullPage: true });
    const stale = await context.newPage();
    try {
      await stale.goto(web.origin + "/admin/studio/settings/models");
      page.once("dialog", dialog => dialog.accept());
      await model.getByRole("button", { name: "启用模型任务", exact: true }).click();
      await expect(model.getByText("模型任务：已启用", { exact: true })).toBeVisible();
      await expect(cookie).toHaveValue("SUB=unsaved-operations-cookie");
      await expect(model.getByLabel("API Key", { exact: true })).toHaveValue("unsaved-operations-key");
      stale.once("dialog", dialog => dialog.accept());
      await stale.getByRole("button", { name: "启用模型任务", exact: true }).click();
      await expect(stale.getByRole("status").filter({ hasText: "模型运行设置已在其他窗口修改" })).toBeVisible();
    } finally { await stale.close(); }
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await expect(page.getByRole("status").filter({ hasNotText: /^全局采集：/ }).filter({ hasText: /\S/ })).toHaveCount(0, { timeout: 8000 });
    await page.screenshot({ path: ".impeccable/review/model-operations-enabled-mobile.png", fullPage: true });
    config.modelCallsEnabled = false; await page.reload();
    await expect(page.getByRole("button", { name: "启用模型任务", exact: true })).toBeDisabled();
    await expect(page.getByText("模型任务：启动配置未允许", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/model-operations-not-allowed-mobile.png", fullPage: true });
  } finally { config.modelCallsEnabled = original; await context.close(); }
});

test("窄屏模型表单错误保留输入和价格配置，无横向溢出", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/models");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const model = page.getByRole("region", { name: "模型服务", exact: true });
    await page.screenshot({ path: ".impeccable/review/model-settings-mobile.png", fullPage: true });
    await model.getByLabel("API基础地址", { exact: true }).fill("https://127.0.0.1/v1");
    await model.getByLabel("API Key", { exact: true }).fill("private-mobile-model-key");
    await expect(model.getByRole("heading", { name: "兼容服务与费用估算", exact: true })).toBeVisible();
    await model.getByLabel("Flash输入单价", { exact: true }).fill("2");
    await model.getByLabel("Flash输出单价", { exact: true }).fill("8");
    await model.getByRole("button", { name: "保存模型连接", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "请填写HTTPS API基础地址" })).toBeVisible();
    await expect(model.getByLabel("API Key", { exact: true })).toHaveValue("private-mobile-model-key");
    await expect(model.getByLabel("Flash输入单价", { exact: true })).toHaveValue("2");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.evaluate("window.scrollTo(0,0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/model-settings-mobile-error.png", fullPage: true });
  } finally { await page.close(); }
});

test("单一Flash设置与费用提醒开关可实际保存，深浅图像分路不会重新出现", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/models");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const model = page.getByRole("region", { name: "模型服务", exact: true });
    await model.getByLabel("API Key", { exact: true }).fill("private-phase2-ui-flash-key");
    const vision = model.getByRole("switch", { name: "允许Flash图片分析", exact: true });
    if (await vision.getAttribute("aria-checked") === "false") await vision.click();
    await model.getByRole("button", { name: "保存模型连接", exact: true }).click();
    await expect(model.getByText("API Key已保存", { exact: false })).toBeVisible();
    const connection = await (await page.request.get(web.origin + "/api/admin/studio/model-connection")).json();
    assert.equal(connection.analysisModel, "deepseek-flash"); assert.equal(connection.qualityModel, "deepseek-flash");
    assert.equal(connection.visionModel, "deepseek-flash");
    const budget = model.getByRole("form", { name: "模型预算设置", exact: true });
    const hard = budget.getByRole("switch", { name: "启用硬预算", exact: true });
    if (await hard.getAttribute("aria-checked") === "true") await hard.click();
    await budget.getByLabel("每日提醒（元）", { exact: true }).fill("0.0001");
    await budget.getByLabel("每月提醒（元）", { exact: true }).fill("0.0001");
    await budget.getByRole("button", { name: "保存费用设置", exact: true }).click();
    await expect(budget.getByLabel("每日上限（元）", { exact: true })).toBeDisabled();
    const saved = await (await page.request.get(web.origin + "/api/admin/studio/model-budget")).json();
    assert.equal(saved.hardLimitEnabled, false); assert.equal(saved.warningPerDay, 0.0001);
    await expect(model.getByText(/已达到每日和每月费用提醒。硬预算未启用，任务继续处理。/)).toBeVisible();
    assert.ok(!(await page.content()).includes("private-phase2-ui-flash-key"));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await budget.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/phase2-flash-budget-${width}.png` });
    }
  } finally { await page.close(); }
});
