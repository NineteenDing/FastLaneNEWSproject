import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { config } from "@aihot/backend/config";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createStudioServer } from "../server.ts";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { trendQueue } from "../backend/trend-collection.ts";
import { bridgeQueue } from "../backend/rsshub-jobs.ts";
import { QueueDeferred } from "@aihot/backend/jobs/queue";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await stopBoss(); await app.close(); await closeDb(); });

test("全局采集暂停保留原新闻任务与健康，跨进程遵守且恢复同ID完成，不绕过启动许可", async t => {
  const path = "/api/admin/studio/collection-operations", runtime = process.env.COLLECT_ENABLED;
  t.after(() => { if (runtime === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = runtime; });
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const save = (version: number, enabled: boolean) => app.inject({ method: "PUT", url: path, headers, payload: { version, enabled } });
  process.env.COLLECT_ENABLED = "false";
  const disabled = await app.inject({ url: path, headers }); assert.equal(disabled.statusCode, 200); assert.equal(disabled.json().runtimeAllowed, false);
  assert.equal(disabled.json().enabled, false); assert.equal((await save(0, true)).statusCode, 409);
  assert.equal((await app.inject({ method: "PUT", url: path, headers: { cookie: headers.cookie }, payload: { version: 0, enabled: false } })).statusCode, 403);
  process.env.COLLECT_ENABLED = "true"; await resources.warm(); config.allowPrivateNetworkFetch = true;
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(transport);
  let requests = 0;
  const upstream = createServer((_req, response) => { requests++; response.end(`<rss><channel><item><title>角色镜头工作流</title><link>https://news.example/collection-control</link><description>固定角色后再组织镜头</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`); });
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const feedUrl = await listenHttpForFetch(upstream);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "collection-control", name: "受控采集新闻", kind: "rss", config: { feedUrl } } })).statusCode, 200);
  const submitted = await app.inject({ method: "POST", url: "/api/admin/sources/collection-control/fetch", headers }); assert.equal(submitted.statusCode, 200);
  const jobId = submitted.json().jobId;
  const paused = await save(0, false); assert.equal(paused.statusCode, 200); assert.equal(paused.json().version, 1); assert.equal(paused.json().enabled, false);
  const creator = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://space.bilibili.com/20813884" } })).json().creator;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 409);
  const child = await promisify(execFile)(process.execPath, ["modules/studio/tests/collection-operations-child.ts"], { env: process.env, cwd: process.cwd(), timeout: 15000 });
  assert.deepEqual(JSON.parse(child.stdout.trim()), { enabled: false });
  const boss = await getBoss(); await registerSourceJobs(boss); await resources.warm(); await delay(2200);
  assert.equal(requests, 0);
  const [pending] = await boss.findJobs(QUEUES.fetchSource, { id: jobId }); assert.equal(pending!.state, "created"); assert.equal(pending!.retryCount, 0);
  const health = (await app.inject({ url: "/api/admin/sources/collection-control", headers })).json(); assert.equal(health.runs.length, 0); assert.equal(health.source.fail_count, 0);
  const resumed = await save(1, true); assert.equal(resumed.statusCode, 200); assert.equal(resumed.json().enabled, true);
  const deadline = Date.now() + 4500;
  while (Date.now() < deadline && (await boss.findJobs(QUEUES.fetchSource, { id: jobId }))[0]!.state !== "completed") await delay(50);
  const [finished] = await boss.findJobs(QUEUES.fetchSource, { id: jobId }); assert.equal(finished!.state, "completed"); assert.equal(finished!.retryCount, 0); assert.equal(requests, 1);
  assert.equal((await app.inject({ url: "/api/admin/sources/collection-control", headers })).json().items[0].title, "角色镜头工作流");
  assert.equal((await save(1, false)).statusCode, 409);
  assert.equal((await app.inject({ url: path, headers })).json().enabled, true);
  await stopBoss();
});

test("暂停时启动仍登记采集计划，损坏配置安全暂停且不覆盖旧版本", async () => {
  const path = "/api/admin/studio/collection-operations";
  assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 2, enabled: false } })).statusCode, 200);
  const schedules = createStudioServer().schedules!;
  for (const name of ["studio.creator.schedule", "studio.trends.schedule", "studio.rsshub.schedule"]) {
    const schedule = schedules.find(schedule => schedule.name === name)!;
    assert.equal(schedule.when!(), true, name); assert.deepEqual(await schedule.run(), { queued: 0 });
  }
  const filename = join(config.dataDir, "collection-control", "state.json"), original = await readFile(filename, "utf8");
  try {
    await writeFile(filename, '{"format":1,"enabled":true}');
    const corrupt = await app.inject({ url: path, headers }); assert.equal(corrupt.statusCode, 200);
    assert.equal(corrupt.json().state, "unavailable"); assert.equal(corrupt.json().version, null); assert.equal(corrupt.json().enabled, false);
    assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 3, enabled: true } })).statusCode, 500);
    const child = await promisify(execFile)(process.execPath, ["modules/studio/tests/collection-operations-child.ts"], { env: process.env, cwd: process.cwd(), timeout: 15000 });
    assert.deepEqual(JSON.parse(child.stdout.trim()), { enabled: false });
    assert.equal(await readFile(filename, "utf8"), '{"format":1,"enabled":true}');
  } finally { await writeFile(filename, original); }
  assert.equal((await app.inject({ url: path, headers })).json().version, 3);
  assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 3, enabled: true } })).statusCode, 200);
});

test("任务领取后才暂停仍退回原任务，不把未采集当成成功完成", async () => {
  const path = "/api/admin/studio/collection-operations";
  assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 4, enabled: false } })).statusCode, 200);
  try {
    await assert.rejects(creatorQueue.run([{ creatorId: "00000000-0000-4000-8000-000000000001" }]), QueueDeferred);
    await assert.rejects(trendQueue.run([{ sourceId: "collection-control" }]), QueueDeferred);
    await assert.rejects(bridgeQueue.run([{ sourceId: "collection-control" }]), QueueDeferred);
  } finally { assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 5, enabled: true } })).statusCode, 200); }
});

test("设置页可暂停恢复及处理旧窗口冲突，保留未保存Key且桌面窄屏可操作", async () => {
  const path = "/api/admin/studio/collection-operations", web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/settings/models"); await page.locator('input[name="password"]').fill("source-resource-password");
    await page.locator('button[type="submit"]').click();
    await inSettingsSection(page, "models", () => page.getByLabel("API Key", { exact: true }).fill("collection-unsaved-key"));
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("link", { name: "采集任务", exact: true }).click();
    const section = page.getByRole("region", { name: "采集任务", exact: true });
    await section.getByRole("button", { name: "暂停新采集", exact: true }).click();
    await expect(section.getByRole("status")).toHaveText("全局采集：已暂停");
    assert.equal((await app.inject({ url: path, headers })).json().enabled, false);
    page.once("dialog", dialog => dialog.accept()); await section.getByRole("button", { name: "恢复采集", exact: true }).click();
    await expect(section.getByRole("status")).toHaveText("全局采集：已启用");
    const state = (await app.inject({ url: path, headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: state.version, enabled: false } })).statusCode, 200);
    await section.getByRole("button", { name: "暂停新采集", exact: true }).click();
    await expect(page.getByText("采集状态已在其他窗口修改，请刷新后重试", { exact: true })).toBeVisible();
    await section.getByRole("button", { name: "刷新采集状态", exact: true }).click();
    await expect(section.getByRole("status")).toHaveText("全局采集：已暂停");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("collection-unsaved-key");
    await expect(page.getByText("采集状态已在其他窗口修改，请刷新后重试", { exact: true })).toHaveCount(0, { timeout: 10000 });
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await section.screenshot({ path: `.impeccable/review/collection-operations-${suffix}.png` });
    }
  } finally { await browser.close(); await web.stop(); }
});
