import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { openPlatformLogin } from "../backend/platform-login-browser.ts";

process.env.COLLECT_ENABLED = "false"; config.modelCallsEnabled = false; config.allowPrivateNetworkFetch = true;
let loggedIn = false;
const platform = createServer((req, res) => {
  if (req.url === "/login-done") loggedIn = true;
  res.setHeader("content-type", "text/html");
  res.end('<body><h1>本地平台登录替身</h1><button style="position:absolute;left:10px;top:80px;width:130px;height:40px" onclick="fetch(`/login-done`)">完成测试登录</button></body>');
});
await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
const address = platform.address(); assert.ok(address && typeof address === "object");
const resources = await sourceResourceFixture({ loginBrowser: async (name, signal) => {
  const page = await openPlatformLogin(name, signal, `http://127.0.0.1:${address.port}/`);
  return { ...page, session: async () => loggedIn ? "web_session=private-browser-accepted; a1=private-browser-device" : "" };
} });
const { app, headers } = resources;
await resources.warm(); await app.ready();
const web = await startWebServer(app.server), browser = await chromium.launch();
await mkdir(".impeccable/review", { recursive: true });
after(async () => { await browser.close(); await web.stop(); await app.close(); await new Promise<void>(resolve => platform.close(() => resolve())); await stopBoss(); await closeDb(); });
async function pageAt(path: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(web.origin + path); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
  return page;
}

test("实际网页打开平台画面并完成自动会话保存，关闭后不泄漏登录信息", async () => {
  const page = await pageAt("/admin/studio/settings/platforms");
  try {
    const xhs = page.getByRole("region", { name: "小红书登录设置", exact: true });
    await xhs.getByRole("button", { name: "登录平台", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "小红书登录", exact: true });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole("img"); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => (node as unknown as { naturalWidth: number }).naturalWidth)).toBe(900);
    await page.screenshot({ path: ".impeccable/review/second-login-desktop.png", fullPage: true });
    const bounds = await image.boundingBox(); assert.ok(bounds);
    await page.mouse.click(bounds.x + 60 * bounds.width / 900, bounds.y + 100 * bounds.height / 650);
    await expect(dialog.getByRole("status").filter({ hasText: "登录会话已加密保存" })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(xhs.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    assert.ok(!(await page.content()).includes("private-browser-accepted"));
  } finally { await page.close(); }
});

test("丰富示例可查看长标题栏目、完整选题依据、日期情报、独立稿件和学习分页，桌面窄屏无横向溢出", async () => {
  const seeded = await app.inject({ method: "POST", url: "/api/admin/studio/acceptance-examples", headers, payload: {} });
  assert.equal(seeded.statusCode, 200, seeded.body);
  const page = await pageAt("/admin/studio/topics");
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await expect(page.getByRole("note")).toContainText("示例");
    await expect(page.locator(".studio-topic-direction-button")).toHaveCount(9);
    await page.locator(".studio-topic-direction-button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".studio-topic-related[open]")).toBeVisible();
    await page.locator(".studio-topic-related").getByRole("button", { name: "查看保存的内容", exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "情报详情", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.goto(web.origin + "/admin/studio/writing");
    const pagination = page.getByRole("navigation", { name: "稿件分页", exact: true });
    await expect(pagination.getByRole("link", { name: "下一页", exact: true })).toBeVisible();
    await pagination.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page.locator(".studio-writing-list > li")).toHaveCount(4);
    await page.locator(".studio-writing-list").getByRole("link", { name: "继续编辑", exact: true }).first().click();
    await expect(page.getByRole("complementary", { name: "本稿引用新闻与视频" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "图片素材", exact: true })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/second-examples-editor.png", fullPage: true });
    await page.goto(web.origin + "/admin/studio/settings/learning");
    const learning = page.getByRole("navigation", { name: "规则学习记录分页", exact: true });
    await expect(learning).toContainText("共 3 次"); await learning.getByRole("button", { name: "下一页", exact: true }).click(); await expect(learning).toContainText("第 2 页");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["topics", "following", "creators", "intelligence", "writing", "settings/learning", "settings/platforms"]) {
        await page.goto(web.origin + "/admin/studio/" + route);
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, `${width}/${route}`);
        if (width === 1440 && ["following", "creators", "writing"].includes(route)) {
          const box = await page.locator(".studio-pagination").first().boundingBox(); assert.ok(box && box.y + box.height <= 900, route + " footer");
        }
        if (["topics", "writing", "settings/learning"].includes(route)) await page.screenshot({ path: `.impeccable/review/second-examples-${route.replaceAll("/", "-")}-${width}.png`, fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
