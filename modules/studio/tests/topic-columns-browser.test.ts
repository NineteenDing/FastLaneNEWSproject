import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { createServer, request as forwardRequest } from "node:http";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";

installModules(SERVER_MODULES);
const app = await buildApp(); let browser: Browser, web: WebServer, unavailable = false;
before(async () => {
  config.adminPassword = "topic-column-browser-password"; config.siteUrl = "http://127.0.0.1";
  await app.ready(); const apiOrigin = await listenHttpForFetch(app.server);
  const api = createServer((request, response) => {
    if (unavailable && request.url?.startsWith("/api/admin/studio/columns")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{}'); return; }
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  web = await startWebServer(api); browser = await chromium.launch(); await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await closeDb(); });
async function login(page: Page) {
  await page.goto(web.origin + "/admin/studio/topics/columns");
  await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
  await expect(page.getByRole("heading", { name: "选题台", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("桌面与手机可配置栏目、停用排序并读取改名前的规则，默认卡片不伪造选题结果", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await login(page);
    await expect(page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "选题台", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("article")).toHaveCount(5);
    for (const [width, suffix] of [[1440, "desktop"], [1024, "tablet"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({ path: `.impeccable/review/topic-columns-${suffix}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await page.getByRole("button", { name: "添加栏目", exact: true }).click();
    await expect(page.getByLabel("栏目名称", { exact: true })).toBeFocused();
    await page.getByLabel("栏目名称", { exact: true }).fill("声音制作");
    await page.getByLabel("优先关注的问题", { exact: true }).fill("多人配音时，怎样保持人物声线与口型一致？".repeat(6));
    await page.getByLabel("希望形成的视频", { exact: true }).fill("操作录屏、前后效果对比");
    await page.screenshot({ path: ".impeccable/review/topic-columns-editor-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "保存栏目", exact: true }).click();
    const custom = page.getByRole("article", { name: "栏目：声音制作", exact: true });
    await expect(custom).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(6);
    await custom.getByRole("button", { name: "编辑规则", exact: true }).click();
    await page.getByLabel("栏目名称", { exact: true }).fill("对白与口型");
    await page.getByLabel("排序数字（较小的靠前）", { exact: true }).fill("1");
    await page.getByLabel("启用栏目", { exact: true }).uncheck();
    await page.getByRole("button", { name: "保存栏目", exact: true }).click();
    const renamed = page.getByRole("article", { name: "栏目：对白与口型", exact: true });
    await expect(renamed).toBeVisible(); await expect(renamed.getByText("已停用 · 版本 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("article").first()).toHaveAttribute("aria-label", "栏目：对白与口型");
    await renamed.getByRole("link", { name: "查看规则版本", exact: true }).click();
    await expect(page.getByRole("heading", { name: "栏目规则历史", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "查看上一版", exact: true }).click();
    await expect(page.getByRole("heading", { name: "声音制作", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: ".impeccable/review/topic-columns-history-desktop.png", fullPage: true });
    await page.getByRole("link", { name: "返回栏目", exact: true }).click();
    await expect(page.getByRole("article", { name: "栏目：对白与口型", exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("两窗口编辑栏目发现冲突，保留未保存输入；固定其他字段不可误改", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); let other: Page | undefined;
  try {
    await login(page); other = await page.context().newPage(); await other.setViewportSize({ width: 390, height: 1100 });
    await other.goto(web.origin + "/admin/studio/topics/columns");
    await other.waitForLoadState("networkidle");
    for (const window of [page, other]) await window.getByRole("article", { name: "栏目：实操与提效", exact: true }).getByRole("button", { name: "编辑规则", exact: true }).click();
    await page.getByRole("textbox", { name: "入选必须满足", exact: true }).fill("必须附可操作步骤与适用条件，事实保持来源。");
    await page.getByRole("button", { name: "保存栏目", exact: true }).click();
    await expect(page.getByRole("article", { name: "栏目：实操与提效", exact: true }).getByText("已启用 · 版本 2", { exact: true })).toBeVisible();
    await other.getByLabel("栏目名称", { exact: true }).fill("未保存的新名称");
    await other.getByRole("button", { name: "保存栏目", exact: true }).click();
    await expect(other.getByText("栏目已被其他窗口修改，请刷新后重试", { exact: false })).toBeVisible();
    await expect(other.getByLabel("栏目名称", { exact: true })).toHaveValue("未保存的新名称");
    await other.screenshot({ path: ".impeccable/review/topic-columns-conflict-mobile.png", fullPage: true });
    await other.reload();
    const fallback = other.getByRole("article", { name: "栏目：其他", exact: true });
    await fallback.getByRole("button", { name: "编辑规则", exact: true }).click();
    await expect(other.getByLabel("栏目名称", { exact: true })).toHaveAttribute("readonly", "");
    await expect(other.getByLabel("启用栏目", { exact: true })).toBeDisabled();
    await other.getByRole("button", { name: "取消", exact: true }).click();
    await expect(fallback.getByRole("button", { name: "编辑规则", exact: true })).toBeFocused();
  } finally { await context.close(); }
});

test("栏目读取失败有独立恢复入口，重载后返回真实规则", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await login(page); unavailable = true; await page.reload();
    await expect(page.getByRole("heading", { name: "栏目未能加载", exact: true })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/topic-columns-error-mobile.png", fullPage: true });
    unavailable = false; await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(page.getByRole("heading", { name: "选题台", exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(6);
  } finally { unavailable = false; await page.close(); }
});
