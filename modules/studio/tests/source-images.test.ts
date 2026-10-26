import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { createImageAssets } from "../backend/image-assets.ts";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
let articleId: string, imagesPath: string, frozenBatchId: string;

test("新闻已提取配图经原任务下载为私有素材，保存文章版本/原链接和未知授权，读取不再请求来源", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "source-image-news", name: "影视制作观察",
    kind: "rss", config: { feedUrl: "https://source-images.example/feed" } } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "source-image-news", title: "参考图工作流", url: "https://source-images.example/article", via: "import",
    bodyText: "先设置参考图，再检查跨镜头角色。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/one.png", alt: "参考图设置界面" }] });
  articleId = saved.articleId; imagesPath = `/api/admin/studio/intelligence/news:${articleId}/images`;
  assert.equal((await app.inject({ url: imagesPath })).statusCode, 401);
  const initial = await app.inject({ url: imagesPath, headers });
  assert.equal(initial.statusCode, 200); assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().state, "pending"); assert.equal(initial.json().candidateCount, 1); assert.deepEqual(initial.json().images, []);
  process.env.COLLECT_ENABLED = "true";
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#345678" } }).png().toBuffer();
  transport.get("https://source-images.example").intercept({ path: "/one.png" }).reply(200, png, { headers: { "content-type": "image/png" } });
  const submit = await app.inject({ method: "POST", url: imagesPath, headers, payload: { versionKey: initial.json().versionKey } });
  assert.equal(submit.statusCode, 200);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const ready = (await app.inject({ url: imagesPath, headers })).json();
  assert.equal(ready.state, "ready"); assert.equal(ready.images.length, 1);
  const image = ready.images[0]; assert.equal(image.sourceUrl, "https://source-images.example/one.png");
  assert.equal(image.articleUrl, "https://source-images.example/article"); assert.equal(image.revision, 1);
  assert.equal(image.description, "参考图设置界面"); assert.equal(image.rights, "unknown");
  assert.match(image.url, /^\/api\/admin\/studio\/image-assets\/[a-f0-9]{64}$/);
  assert.equal((await app.inject({ url: image.url })).statusCode, 401);
  const local = await app.inject({ url: image.url, headers }); assert.equal(local.statusCode, 200);
  assert.equal((await sharp(local.rawPayload).metadata()).width, 640);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/news:${articleId}`, headers })).json();
  assert.deepEqual(detail.sourceImages.images, ready.images);
  assert.deepEqual((await app.inject({ url: imagesPath, headers })).json().images, ready.images);
  transport.assertNoPendingInterceptors();
});

test("新闻修订替换当前配图但不改冻结证据，旧窗口不能下载新版本，旧素材仍受引用保护", async t => {
  const original = (await app.inject({ url: imagesPath, headers })).json();
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json(), duration = 48 * 3600_000;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.parse(current.endsAt) + 1000) }); await resources.warm();
  let batchId = "";
  for (let start = Date.parse(plan.startsAt); start <= Date.parse(current.startsAt); start += duration) {
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: new Date(start).toISOString() } });
    assert.equal(frozen.statusCode, 200); batchId = frozen.json().batch.id;
  }
  const frozenPath = `/api/admin/studio/topic-batches/${batchId}/materials`;
  frozenBatchId = batchId;
  const read = await app.inject({ url: frozenPath, headers });
  assert.deepEqual(read.json().rows[0].sourceImages.images, original.images);
  await upsertMaterial({ sourceId: "source-image-news", title: "参考图工作流", url: "https://source-images.example/article", via: "import",
    bodyText: "新增第二个步骤，先检查镜头再设置参考图。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/two.png", alt: "新版参考图界面" }] });
  assert.equal((await app.inject({ method: "POST", url: imagesPath, headers, payload: { versionKey: original.versionKey } })).statusCode, 409);
  const next = (await app.inject({ url: imagesPath, headers })).json(); assert.equal(next.revision, 2); assert.deepEqual(next.images, []);
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#985432" } }).png().toBuffer();
  transport.get("https://source-images.example").intercept({ path: "/two.png" }).reply(200, png);
  assert.equal((await app.inject({ method: "POST", url: imagesPath, headers, payload: { versionKey: next.versionKey } })).statusCode, 200);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const ready = (await app.inject({ url: imagesPath, headers })).json(); assert.equal(ready.images[0].revision, 2);
  assert.notEqual(ready.images[0].assetId, original.images[0].assetId);
  assert.deepEqual((await app.inject({ url: frozenPath, headers })).json().rows[0].sourceImages.images, original.images);
  await createImageAssets().prune(new Date(Date.now() + 86400_000));
  assert.equal((await app.inject({ url: original.images[0].url, headers })).statusCode, 200);
  transport.assertNoPendingInterceptors();
});

test("部分图片失败保留已保存素材，显式重试只下载缺失图片且重复提交不多建任务", async () => {
  const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#123456" } }).png().toBuffer();
  const saved = await upsertMaterial({ sourceId: "source-image-news", title: "两步镜头设置", url: "https://source-images.example/partial", via: "import",
    bodyText: "两个步骤分别提供截图。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/step1.png" }, { kind: "image", url: "https://source-images.example/step2.png" }] });
  const path = `/api/admin/studio/intelligence/news:${saved.articleId}/images`, initial = (await app.inject({ url: path, headers })).json();
  transport.get("https://source-images.example").intercept({ path: "/step1.png" }).reply(200, png);
  transport.get("https://source-images.example").intercept({ path: "/step2.png" }).reply(503, "private upstream detail");
  const submit = () => app.inject({ method: "POST", url: path, headers, payload: { versionKey: initial.versionKey } });
  assert.equal((await submit()).json().queued, true); assert.equal((await submit()).json().queued, false);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!;
  const boss = await getBoss(), [first] = await boss.fetch(queue.name); assert.ok(first);
  await assert.rejects(queue.run([first.data] as never[]), /来源配图未全部保存/); await boss.cancel(queue.name, first.id);
  const partial = (await app.inject({ url: path, headers })).json(); assert.equal(partial.state, "failed"); assert.equal(partial.images.length, 1);
  assert.ok(!JSON.stringify(partial).includes("private upstream detail"));
  assert.equal((await app.inject({ url: partial.images[0].url, headers })).statusCode, 200);
  transport.get("https://source-images.example").intercept({ path: "/step2.png" }).reply(200, png);
  assert.equal((await submit()).json().queued, true);
  const [retry] = await boss.fetch(queue.name); assert.ok(retry);
  await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
  const ready = (await app.inject({ url: path, headers })).json(); assert.equal(ready.state, "ready"); assert.equal(ready.images.length, 2);
  assert.equal(ready.images[0].assetId, ready.images[1].assetId, "相同图片内容只存一份，出处仍各自保留");
  transport.assertNoPendingInterceptors();
});

test("来源图的私网地址与伪装SVG不会成为本地可读图片，采集关闭不提交新下载", async () => {
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!, boss = await getBoss();
  for (const [suffix, url] of [["private", "http://127.0.0.1:1/secret.png"], ["svg", "https://source-images.example/fake.png"]]) {
    const saved = await upsertMaterial({ sourceId: "source-image-news", title: "配图边界", url: `https://source-images.example/${suffix}`, via: "import",
      bodyText: "配图来源需要受控读取。", bodyStatus: "ok", media: [{ kind: "image", url: url! }] });
    const path = `/api/admin/studio/intelligence/news:${saved.articleId}/images`, status = (await app.inject({ url: path, headers })).json();
    if (suffix === "svg") transport.get("https://source-images.example").intercept({ path: "/fake.png" }).reply(200, '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>', { headers: { "content-type": "image/png" } });
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { versionKey: status.versionKey } })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    config.allowPrivateNetworkFetch = suffix !== "private";
    try { await assert.rejects(queue.run([job.data] as never[]), /来源配图未全部保存/); }
    finally { config.allowPrivateNetworkFetch = true; }
    await boss.cancel(queue.name, job.id);
    const failed = (await app.inject({ url: path, headers })).json(); assert.equal(failed.state, "failed"); assert.deepEqual(failed.images, []);
    process.env.COLLECT_ENABLED = "false";
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { versionKey: status.versionKey } })).statusCode, 409);
    process.env.COLLECT_ENABLED = "true";
  }
  transport.assertNoPendingInterceptors();
});

test("网页可保存/重试实际来源图，桌面与手机只加载本地素材，改版先刷新且历史不读取实时配图", async () => {
  await resources.warm();
  const saved = await upsertMaterial({ sourceId: "source-image-news", title: "隔离测试：参考图设置", url: "https://source-images.example/browser", via: "import",
    bodyText: "隔离测试材料：先固定参考图，再检查镜头。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/browser.png", alt: "隔离测试来源图" }] });
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!, boss = await getBoss();
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const external: string[] = []; page.on("request", request => { if (new URL(request.url()).hostname === "source-images.example") external.push(request.url()); });
  await mkdir(".impeccable/review", { recursive: true });
  async function capture(name: string) {
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    await expect(page.getByRole("link", { name: "跳到正文", exact: true })).not.toBeInViewport();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: `.impeccable/review/source-images-${name}.png`, fullPage: true });
  }
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/news:${saved.articleId}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "新闻来源配图", exact: true });
    transport.get("https://source-images.example").intercept({ path: "/browser.png" }).reply(503, "fixture unavailable");
    await panel.getByRole("button", { name: "保存来源配图", exact: true }).click();
    await expect(panel).toContainText("配图已排队");
    const [first] = await boss.fetch(queue.name); assert.ok(first);
    await assert.rejects(queue.run([first.data] as never[]), /来源配图未全部保存/); await boss.cancel(queue.name, first.id);
    await panel.getByRole("button", { name: "刷新配图状态", exact: true }).click(); await expect(panel.getByRole("button", { name: "重试保存配图", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 }); await capture("failed-mobile");
    const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#345678" } }).png().toBuffer();
    transport.get("https://source-images.example").intercept({ path: "/browser.png" }).reply(200, png);
    await panel.getByRole("button", { name: "重试保存配图", exact: true }).click(); await expect(panel).toContainText("配图已排队");
    const [retry] = await boss.fetch(queue.name); assert.ok(retry);
    await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
    await panel.getByRole("button", { name: "刷新配图状态", exact: true }).click(); await expect(panel).toContainText("来源配图已保存 · 已保存 1 / 1 张");
    await expect(panel.getByRole("img", { name: "隔离测试来源图", exact: true })).toHaveJSProperty("naturalWidth", 640);
    await expect(panel.getByRole("link", { name: "图片原链接", exact: true })).toHaveAttribute("href", "https://source-images.example/browser.png");
    for (const [width, name] of [[1440, "desktop"], [390, "mobile"]] as const) { await page.setViewportSize({ width, height: 1000 }); await capture(name); }
    await upsertMaterial({ sourceId: "source-image-news", title: "隔离测试：参考图设置", url: "https://source-images.example/browser", via: "import",
      bodyText: "隔离测试材料的新修订，增加镜头检查。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/not-downloaded.png" }] });
    await panel.getByRole("button", { name: "刷新配图状态", exact: true }).click(); await expect(panel).toContainText("新闻版本已更新，请刷新情报后查看对应配图");
    await capture("changed-mobile"); await panel.getByRole("button", { name: "刷新情报", exact: true }).click();
    await expect(panel).toContainText("配图等待安排"); await expect(panel.getByRole("img")).toHaveCount(0);
    let imageReads = 0; page.on("request", request => { if (/\/intelligence\/[^/]+\/images$/.test(new URL(request.url()).pathname)) imageReads++; });
    await page.goto(web.origin + `/admin/studio/topics/batches/${frozenBatchId}`);
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "冻结材料", exact: true }).locator("summary").first().click();
    await expect(page.getByRole("img", { name: "参考图设置界面", exact: true })).toHaveJSProperty("naturalWidth", 640);
    await expect(page.getByRole("button", { name: "刷新配图状态", exact: true })).toHaveCount(0);
    await capture("frozen-mobile"); await page.waitForLoadState("networkidle"); assert.equal(imageReads, 0); assert.deepEqual(external, []);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); await browser.close(); await web.stop(); }
});

test("JPEG来源照片继续使用JPEG编码，避免全转PNG挤占小系统盘", async () => {
  const saved = await upsertMaterial({ sourceId: "source-image-news", title: "制作案例照片", url: "https://source-images.example/photo-article", via: "import",
    bodyText: "案例照片作为来源素材。", bodyStatus: "ok", media: [{ kind: "image", url: "https://source-images.example/photo.jpg" }] });
  const path = `/api/admin/studio/intelligence/news:${saved.articleId}/images`, initial = (await app.inject({ url: path, headers })).json();
  const photo = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#345678" } }).jpeg({ quality: 90 }).toBuffer();
  transport.get("https://source-images.example").intercept({ path: "/photo.jpg" }).reply(200, photo);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { versionKey: initial.versionKey } })).statusCode, 200);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.news.images")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const ready = (await app.inject({ url: path, headers })).json(), local = await app.inject({ url: ready.images[0].url, headers });
  assert.equal(local.headers["content-type"], "image/jpeg"); assert.equal((await sharp(local.rawPayload).metadata()).width, 600);
  transport.assertNoPendingInterceptors();
});
