import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect, type Browser } from "@playwright/test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";
import { bilibiliFixture, zhihuFixture } from "./mediacrawler-fixture.ts";
import { tiebaFixture } from "./tieba-fixture.ts";
import { douyinFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouFixture, kuaishouCookie } from "./kuaishou-fixture.ts";

installModules(SERVER_MODULES);
const app = await buildApp(), previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
let browser: Browser, web: WebServer;
before(async () => {
  config.adminPassword = "creator-collection-browser-password"; config.siteUrl = "http://127.0.0.1";
  await app.ready(); web = await startWebServer(app.server); browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("桌面提交真实后台采集任务，查看已入库简介、原作品、热度与评论样本", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://space.bilibili.com/20813884");
    await page.getByRole("button", { name: "确认添加" }).click();
    await page.getByRole("button", { name: "采集更新", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已提交后台采集");
    bilibiliFixture(transport, { workCount: 35 });
    const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name);
    assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await page.reload();
    const account = page.getByRole("article", { name: "影视流程研究", exact: true });
    await expect(account.getByText("最近采集成功", { exact: true })).toBeVisible();
    await expect(account.getByText("已检查第 1 页，后续页面等待继续采集。", { exact: true })).toBeVisible();
    await account.getByText("查看收录（1 条）", { exact: true }).click();
    await account.getByText("角色一致性的方法", { exact: true }).click();
    await expect(account.getByText("换镜头后怎么维持角色？", { exact: false })).toBeVisible();
    await expect(account.getByText("先锁定参考，再组织镜头", { exact: true })).toBeVisible();
    await account.getByText("查看热度记录（最近 1 次）", { exact: true }).click();
    await expect(account.getByRole("link", { name: "打开原作品", exact: true })).toHaveAttribute("href", "https://www.bilibili.com/video/BV1fixture");
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/creator-collection-desktop.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("窄屏收录加载失败可重试，真实内容展开与长文本不横向溢出", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.route("**/api/admin/studio/creators/*/contents?*", route => route.fulfill({ status: 503, body: "temporary fixture" }));
    await page.getByText("查看收录（1 条）", { exact: true }).click();
    await expect(page.getByText("收录内容未能加载，请检查登录或网络后重试。", { exact: true })).toBeVisible();
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/creator-collection-error.png", fullPage: true });
    await page.unroute("**/api/admin/studio/creators/*/contents?*");
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await page.getByText("角色一致性的方法", { exact: true }).click();
    await expect(page.getByText("先锁定参考，再组织镜头", { exact: true })).toBeVisible();
    await page.locator("h1").click();
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/creator-collection-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
  } finally { await page.close(); }
});

test("知乎回答文章在现有收录区分别展示，保留赞同口径与问题专栏入口", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.getByRole("link", { name: "配置平台登录", exact: true }).click();
    const login = page.getByRole("region", { name: "知乎登录设置", exact: true });
    await login.getByLabel("登录信息（Cookie）", { exact: true }).fill("d_c0=private-zhihu-device; z_c0=private-zhihu-login");
    await login.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(login.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://www.zhihu.com/people/film-creator");
    await page.getByRole("button", { name: "确认添加", exact: true }).click();
    const pending = page.getByRole("article", { name: "知乎博主 · film-creator", exact: true });
    await pending.getByRole("button", { name: "采集更新", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已提交后台采集");
    zhihuFixture(transport, { answersComplete: true });
    const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await page.reload();
    const account = page.getByRole("article", { name: "影视创作实验室", exact: true });
    await account.getByText("查看收录（2 条）", { exact: true }).click();
    await account.getByText("如何保持不同镜头里的角色一致？", { exact: true }).click();
    await account.getByText("把分镜接成一条制作流程", { exact: true }).click();
    await expect(account.getByText("回答正文", { exact: false })).toBeVisible();
    await expect(account.getByText("文章正文", { exact: false })).toBeVisible();
    await expect(account.getByText("赞同 218 · 评论 12", { exact: true })).toBeVisible();
    await expect(account.getByRole("link", { name: "所属问题：如何保持不同镜头里的角色一致？", exact: true })).toHaveAttribute("href", "https://www.zhihu.com/question/77001");
    await expect(account.getByRole("link", { name: "所属专栏：AI影视制作", exact: true })).toHaveAttribute("href", "https://zhuanlan.zhihu.com/ai-film");
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await expect(page.getByRole("status")).toHaveText("", { timeout: 8000 });
    await page.screenshot({ path: ".impeccable/review/zhihu-collection-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/zhihu-collection-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("贴吧在已有关注与收录区完成操作，正文和楼层回帖在桌面与窄屏清楚展示", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await page.getByRole("link", { name: "配置平台登录", exact: true }).click();
    const login = page.getByRole("region", { name: "百度贴吧登录设置", exact: true });
    await login.getByLabel("登录信息（Cookie）", { exact: true }).fill("BDUSS=private-tieba-cookie");
    await login.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(login.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://tieba.baidu.com/home/main?id=tb.fixture");
    await page.getByRole("button", { name: "确认添加", exact: true }).click();
    const pending = page.getByRole("article", { name: "百度贴吧博主 · tb.fixture", exact: true });
    await pending.getByRole("button", { name: "采集更新", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已提交后台采集");
    tiebaFixture(transport, { complete: true });
    const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await page.reload();
    const account = page.getByRole("article", { name: "漫剧镜头研究", exact: true });
    await page.getByLabel("博主平台", { exact: true }).selectOption("tieba");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(account).toBeVisible();
    await account.getByText("查看收录（1 条）", { exact: true }).click();
    await account.getByText("角色一致性的镜头安排", { exact: true }).click();
    await expect(account.getByText("先锁定角色参考，再切换不同景别。", { exact: true })).toBeVisible();
    await expect(account.getByText("第 2 楼 ·", { exact: true })).toBeVisible();
    await expect(account.getByText("换角度时参考强度怎么调？", { exact: false })).toBeVisible();
    await expect(account.getByRole("link", { name: "打开原作品", exact: true })).toHaveAttribute("href", "https://tieba.baidu.com/p/99001");
    await expect(page.getByRole("status")).toHaveText("", { timeout: 8000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/tieba-collection-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/tieba-collection-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("抖音在现有页面显示视频简介与图文正文，保留评论缺口和原作品入口", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/platforms");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const login = page.getByRole("region", { name: "抖音登录设置", exact: true });
    await login.getByLabel("登录信息（Cookie）", { exact: true }).fill(douyinCookie);
    await login.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(login.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://www.douyin.com/user/MS4wLjABAAAAfilm_fixture");
    await page.getByRole("button", { name: "确认添加", exact: true }).click();
    const pending = page.getByRole("article", { name: "抖音博主 · MS4wLjABAAAAfilm_fixture", exact: true });
    await pending.getByRole("button", { name: "采集更新", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已提交后台采集");
    douyinFixture(transport, { complete: true });
    const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await page.reload();
    await page.getByLabel("博主平台", { exact: true }).selectOption("douyin");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const account = page.getByRole("article", { name: "AI镜头实验", exact: true });
    await account.getByText("查看收录（2 条）", { exact: true }).click();
    await account.locator("summary").filter({ hasText: "先固定角色，再做不同镜头。" }).click();
    await account.locator("summary").filter({ hasText: "图文展示分镜参考和检查点。" }).click();
    await expect(account.getByText("视频简介 ·", { exact: false })).toBeVisible();
    await expect(account.getByText("图文笔记 ·", { exact: false })).toBeVisible();
    await expect(account.getByText("换景别以后角色会变吗？", { exact: false })).toBeVisible();
    await expect(account.getByRole("link", { name: "打开原作品", exact: true })).toHaveCount(2);
    await expect(account.locator('a[href="https://www.douyin.com/video/7600000000000000001"]')).toBeVisible();
    await expect(account.locator('a[href="https://www.douyin.com/video/7600000000000000002"]')).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("", { timeout: 8000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/douyin-collection-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await page.screenshot({ path: ".impeccable/review/douyin-collection-mobile.png", fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("快手设置和关注采集贯通，桌面与手机可展开作品评论并保留未转写提示", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + "/admin/studio/settings/platforms");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const login = page.getByRole("region", { name: "快手登录设置", exact: true });
    await login.getByLabel("登录信息（Cookie）", { exact: true }).fill(kuaishouCookie);
    await login.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(login.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await page.getByRole("button", { name: "添加博主", exact: true }).click();
    await page.getByLabel("博主主页链接", { exact: true }).fill("https://www.kuaishou.com/profile/3xfilmfixture");
    await page.getByRole("button", { name: "确认添加", exact: true }).click();
    const pending = page.getByRole("article", { name: "快手博主 · 3xfilmfixture", exact: true });
    await pending.getByRole("button", { name: "采集更新", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已提交后台采集");
    kuaishouFixture(transport, { complete: true });
    const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await page.reload(); await page.getByLabel("博主平台", { exact: true }).selectOption("kuaishou");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const account = page.getByRole("article", { name: "漫剧制作记录", exact: true });
    await account.getByText("查看收录（1 条）", { exact: true }).click();
    await account.locator("summary").filter({ hasText: "固定角色，再安排近景与远景。" }).click();
    await expect(account.getByText("长镜头怎么保证角色一致？", { exact: false })).toBeVisible();
    await expect(account.getByRole("link", { name: "打开原作品", exact: true })).toHaveAttribute("href", "https://www.kuaishou.com/short-video/3xfilmvideo");
    await expect(account.getByText("视频简介 ·", { exact: false })).toBeVisible();
    await expect(account.getByRole("link", { name: "查看完整情报与转写", exact: true })).toHaveAttribute("href", /^\/admin\/studio\/intelligence\/creator%3A/);
    await expect(page.getByRole("status")).toHaveText("", { timeout: 8000 });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      await page.screenshot({ path: `.impeccable/review/kuaishou-collection-${suffix}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); }
});

test("平台登录表单在脚本准备完成前禁止输入，避免早填Cookie丢失或保存按钮一直禁用", async () => {
  const page = await browser.newPage();
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve; });
  try {
    await page.goto(web.origin + "/admin/studio/creators");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("button", { name: "添加博主", exact: true })).toBeVisible();
    await page.route("**/assets/*.js", async route => { await scriptsReady; await route.continue(); });
    await page.goto(web.origin + "/admin/studio/settings/platforms", { waitUntil: "commit" });
    const login = page.getByRole("region", { name: "快手登录设置", exact: true }), input = login.getByLabel("登录信息（Cookie）", { exact: true });
    await expect(input).toBeVisible(); await expect(input).toBeDisabled();
    releaseScripts(); await expect(input).toBeEnabled();
    await input.fill(kuaishouCookie); await login.getByRole("button", { name: "保存登录信息", exact: true }).click();
    await expect(login.getByText("已保存 · 尚未验证", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
  } finally { releaseScripts(); await page.close(); }
});
