import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss, getBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("空材料不等于来源已检查；当期显示未检查与暂停，截止快照不受后来取消关注或新增来源影响", async t => {
  for (const [id, enabled] of [["coverage-news", true], ["coverage-paused", false]] as const) {
    const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name: id, kind: "rss", enabled, config: { feedUrl: `https://${id}.example/feed` } } });
    assert.equal(created.statusCode, 200);
  }
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(added.statusCode, 200); const creator = added.json().creator;
  const endpoint = "/api/admin/studio/topic-batches/current/coverage";
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  const response = await app.inject({ url: endpoint + "?limit=1", headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const value = response.json(); assert.equal(value.state, "current"); assert.equal(value.total, 3); assert.equal(value.rows.length, 1); assert.equal(value.hasMore, true);
  assert.equal(value.counts.not_checked, 2); assert.equal(value.counts.paused, 1); assert.equal(value.counts.checked, 0);
  const page2 = (await app.inject({ url: endpoint + "?page=2&limit=1", headers })).json(); assert.notEqual(page2.rows[0].id, value.rows[0].id);
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, enabled: false, startsAt: window.startsAt } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(window.endsAt) }); await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: window.startsAt } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 0);
  const snapshotUrl = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/coverage`;
  const snapshot = (await app.inject({ url: snapshotUrl, headers })).json(); assert.equal(snapshot.state, "snapshot"); assert.equal(snapshot.total, 3);
  assert.equal(snapshot.counts.not_checked, 2); assert.equal(snapshot.counts.checked, 0);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${creator.id}/archive`, headers, payload: { version: creator.version, archived: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "coverage-later", name: "later", kind: "rss", config: { feedUrl: "https://coverage-later.example/rss" } } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: snapshotUrl, headers })).json(), snapshot);
  assert.equal((await app.inject({ url: snapshotUrl })).statusCode, 401);
});

test("来源覆盖按需读取，错误保留记录且可重试，桌面与手机可查看截止快照", async () => {
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let reads = 0; page.on("request", request => { if (request.url().includes("/coverage?")) reads++; });
    await page.goto(web.origin + "/admin/studio/topics"); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    const summary = page.getByText("查看来源检查与分页缺口", { exact: true }); await expect(summary).toBeVisible(); assert.equal(reads, 0);
    await summary.click(); const list = page.getByRole("list", { name: "来源检查记录", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(3); await expect(list.getByText("已暂停", { exact: false })).toBeVisible();
    await expect(list.getByRole("link", { name: "later", exact: true })).toBeVisible();
    await page.route("**/api/admin/studio/topic-batches/current/coverage?*", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.getByRole("button", { name: "刷新检查记录", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("来源检查记录未能加载"); await expect(list.getByRole("listitem")).toHaveCount(3);
    await page.unroute("**/api/admin/studio/topic-batches/current/coverage?*"); await page.getByRole("button", { name: "刷新检查记录", exact: true }).click(); await expect(page.getByRole("alert")).toHaveCount(0);
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/topic-source-coverage-${suffix}.png`, fullPage: true });
    }
    await page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "历史", exact: true }).click();
    await expect(page.getByRole("heading", { name: "历史选题", exact: true })).toBeVisible();
    await openTopicProcessing(page);
    await page.getByText("查看来源检查与分页缺口", { exact: true }).click();
    await expect(page.getByRole("list", { name: "来源检查记录", exact: true }).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("list", { name: "来源检查记录", exact: true }).getByRole("link", { name: "later", exact: true })).toHaveCount(0);
    await expect(page.getByText("查看截止时保存的来源清单与检查记录", { exact: false })).toBeVisible();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
  } finally { await browser.close(); await web.stop(); }
});

test("来源检查保留实际分页进度，成功后仍可报告登录失效而不冒充没有新内容", async t => {
  const old = (await app.inject({ url: "/api/admin/studio/creators?archived=true", headers })).json().rows[0];
  const restored = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${old.id}/archive`, headers, payload: { version: old.version, archived: false } });
  assert.equal(restored.statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${old.id}/status`, headers, payload: { version: restored.json().creator.version, enabled: true } })).statusCode, 200);
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const submit = async () => { assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${old.id}/collect`, headers, payload: {} })).statusCode, 200); const [job] = await boss.fetch(queue.name); assert.ok(job); return job; };
  const read = async () => (await app.inject({ url: "/api/admin/studio/topic-batches/current/coverage", headers })).json();
  const job = await submit(); bilibiliFixture(transport, { workCount: 31 });
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  let value = await read(), row = value.rows.find((row: { id: string }) => row.id === "creator:" + old.id);
  assert.equal(row.state, "partial"); assert.equal(value.counts.partial, 1); assert.equal(row.pagesComplete, false);
  assert.equal(row.page, 1); assert.equal(row.nextPage, 2);
  const next = await submit(); bilibiliFixture(transport, { workCount: 31 });
  await queue.run([next.data] as never[]); await boss.complete(queue.name, next.id);
  value = await read(); row = value.rows.find((row: { id: string }) => row.id === "creator:" + old.id);
  assert.equal(row.state, "checked"); assert.equal(row.pagesComplete, true); assert.equal(row.page, 2); assert.equal(row.nextPage, null);
  const success = row.lastCheckedAt;
  const invalid = await submit(); transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/nav" }).reply(200, { code: -101, message: "private-upstream-login-error" });
  await assert.rejects(queue.run([invalid.data] as never[])); await boss.fail(queue.name, invalid.id);
  value = await read(); row = value.rows.find((row: { id: string }) => row.id === "creator:" + old.id);
  assert.equal(row.state, "login_required"); assert.equal(value.counts.login_required, 1); assert.equal(value.counts.checked, 0); assert.equal(row.lastCheckedAt, success);
  assert.ok(!JSON.stringify(value).includes("private-upstream-login-error"));
  transport.assertNoPendingInterceptors();
});
