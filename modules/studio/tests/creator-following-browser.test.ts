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
  config.adminPassword = "creator-browser-test-password";
  config.siteUrl = "http://127.0.0.1";
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });

test("桌面从新闻切换博主，添加、暂停、移除及恢复均操作真实关注记录", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/following");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.getByRole("navigation", { name: "关注类型" }).getByRole("link", { name: "博主", exact: true }).click();
    await expect(page.getByRole("heading", { name: "还没有匹配的博主" })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/creators-empty.png" });
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    const input = page.getByLabel("博主主页链接", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("https://space.bilibili.com/434377496?from=browser");
    await page.getByRole("button", { name: "确认添加" }).click();
    const account = page.getByRole("article", { name: "B站博主 · 434377496", exact: true });
    await expect(account).toBeVisible();
    await expect(account.getByText("未提供", { exact: true })).toHaveCount(2);
    await expect(account.getByRole("link", { name: "打开B站博主 · 434377496主页", exact: true })).toHaveAttribute("href", "https://space.bilibili.com/434377496");
    const me = await (await page.request.get(web.origin + "/api/admin/me")).json();
    for (const url of ["https://www.douyin.com/user/MS4wLjABAAAAexample", "https://www.kuaishou.com/profile/3x84qugg4ch9zhs",
      "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae", "https://weibo.com/u/5756404150",
      "https://tieba.baidu.com/home/main?id=tb.1.example", "https://www.zhihu.com/people/yd1234567"]) {
      assert.equal((await page.request.post(web.origin + "/api/admin/studio/creators", { headers: { "x-csrf-token": me.csrf }, data: { url } })).status(), 200);
    }
    await page.reload(); await expect(page.getByRole("article")).toHaveCount(7);
    await page.screenshot({ path: ".impeccable/review/creators-desktop.png" });
    await account.getByRole("button", { name: "暂停关注" }).click();
    await expect(account.getByRole("button", { name: "启用关注" })).toBeVisible();
    await account.getByRole("button", { name: "博主档案", exact: true }).click();
    await page.getByRole("navigation", { name: /B站博主.*分类/ }).getByRole("button", { name: "关注与采集", exact: true }).click();
    page.once("dialog", dialog => dialog.accept()); await page.getByRole("dialog").getByRole("button", { name: "移除关注", exact: true }).click();
    await expect(account).toHaveCount(0);
    await page.getByLabel("显示范围").selectOption("true"); await page.getByRole("button", { name: "搜索", exact: true }).click();
    await account.getByRole("button", { name: "博主档案", exact: true }).click();
    await page.getByRole("navigation", { name: /B站博主.*分类/ }).getByRole("button", { name: "关注与采集", exact: true }).click();
    await expect(account.getByRole("button", { name: "恢复到关注库" })).toBeVisible();
    await account.getByRole("button", { name: "恢复到关注库" }).click(); await expect(account).toHaveCount(0);
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await expect(account.getByRole("button", { name: "启用关注" })).toBeVisible();
    const batch = page.getByRole("group", { name: "批量管理博主" });
    await batch.getByRole("checkbox", { name: "选择本页" }).check();
    await expect(batch).toContainText("已选 7 个");
    await batch.getByRole("button", { name: "批量暂停" }).click();
    await expect(page.getByRole("article").getByRole("button", { name: "启用关注", exact: true })).toHaveCount(7);
    await expect(batch).toContainText("已选 0 个");
    const second = page.getByRole("article", { name: "抖音博主 · MS4wLjABAAAAexample", exact: true });
    await account.getByRole("checkbox").check(); await second.getByRole("checkbox").check();
    await batch.getByRole("button", { name: "关联为同一博主" }).click();
    const linking = page.getByRole("region", { name: "关联同一博主", exact: true });
    await expect(linking.getByLabel("博主主体名称", { exact: true })).toBeFocused();
    await linking.getByLabel("博主主体名称", { exact: true }).fill("镜头与角色研究");
    await linking.getByRole("button", { name: "确认关联", exact: true }).click();
    await expect(page.getByText("同一博主：镜头与角色研究", { exact: true })).toHaveCount(2);
    await expect(linking).toHaveCount(0); await expect(batch).toContainText("已选 0 个");
    await page.screenshot({ path: ".impeccable/review/creator-subjects-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".impeccable/review/creator-subjects-mobile.png" });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await account.getByRole("checkbox").check();
    await batch.getByRole("button", { name: "解除关联", exact: true }).click();
    await expect(account.getByText("同一博主：镜头与角色研究", { exact: true })).toHaveCount(0);
    await expect(second.getByText("同一博主：镜头与角色研究", { exact: true })).toBeVisible();
    await account.getByRole("checkbox").check(); await batch.getByRole("button", { name: "关联为同一博主" }).click();
    await linking.getByLabel("关联方式", { exact: true }).selectOption("existing");
    await expect(linking.getByLabel("已有博主主体", { exact: true }).getByRole("option")).toHaveCount(2);
    await linking.getByLabel("已有博主主体", { exact: true }).selectOption({ label: "镜头与角色研究 · 1 个账号" });
    await linking.getByRole("button", { name: "确认关联", exact: true }).click();
    await expect(page.getByText("同一博主：镜头与角色研究", { exact: true })).toHaveCount(2);
    await page.getByRole("navigation", { name: "关注类型" }).getByRole("link", { name: "新闻源", exact: true }).click();
    await expect(page.getByRole("link", { name: "添加新闻源", exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("窄屏可筛选、清空和添加错误恢复，长账号不会横向溢出", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("article")).toHaveCount(7);
    await page.screenshot({ path: ".impeccable/review/creators-mobile.png" });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.getByRole("searchbox", { name: "搜索博主" }).fill("不存在");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "还没有匹配的博主" })).toBeVisible();
    await page.getByRole("link", { name: "重置", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(7);
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://example.com/not-a-platform");
    await page.getByRole("button", { name: "确认添加" }).click();
    await expect(page.getByRole("status")).toContainText("分享链接未指向可识别的博主主页，请复制完整个人主页链接重试");
    await expect(page.getByLabel("博主主页链接", { exact: true })).toHaveValue("https://example.com/not-a-platform");
    await page.screenshot({ path: ".impeccable/review/creators-mobile-error.png" });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
  } finally { await page.close(); }
});
