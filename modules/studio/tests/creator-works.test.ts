import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture, weiboFixture } from "./mediacrawler-fixture.ts";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { stub } from "../../../tests/setup.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
let frozenBatchId: string, frozenWorkId: string;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("确认同作品跨平台发布后保留各自指标与原文，修改关联不改变已冻结批次", async t => {
  const path = "/api/admin/studio/creator-works";
  assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  await resources.warm();
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  for (const source of [
    { platform: "bilibili", url: "https://space.bilibili.com/20813884", cookie: "SESSDATA=private-works-fixture" },
    { platform: "weibo", url: "https://weibo.com/u/5756404150", cookie: "SUB=private-works-fixture" },
  ]) {
    assert.equal((await app.inject({ method: "PUT", url: `/api/admin/studio/platform-sessions/${source.platform}`, headers, payload: { version: 0, cookie: source.cookie } })).statusCode, 200);
    const account = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: source.url } })).json().creator;
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${account.id}/collect`, headers, payload: {} })).statusCode, 200);
    if (source.platform === "bilibili") bilibiliFixture(transport); else weiboFixture(transport, { complete: true });
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  }
  const rows = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows;
  assert.equal(rows.length, 2);
  const ids = rows.map((row: { id: string }) => row.id);
  const created = await app.inject({ method: "POST", url: path, headers, payload: { title: "角色参考与镜头衔接", materialIds: ids } });
  assert.equal(created.statusCode, 200, created.body); const work = created.json().work;
  frozenWorkId = work.id;
  assert.equal(work.version, 1); assert.equal(work.publications.length, 2);
  assert.equal(work.publications.find((row: { platform: string }) => row.platform === "bilibili").metrics.views, 12000);
  assert.equal(work.publications.find((row: { platform: string }) => row.platform === "weibo").metrics.likes, 120);
  const ref = { id: work.id, title: work.title, version: 1, publicationCount: 2 };
  for (const id of ids) {
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${id}`, headers })).json();
    assert.deepEqual(detail.source.work, ref);
    const related = await app.inject({ url: `/api/admin/studio/intelligence/${id}/work`, headers });
    assert.equal(related.statusCode, 200); assert.equal(related.headers["cache-control"], "no-store"); assert.deepEqual(related.json().work, work);
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().total, 2);
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  const start = new Date(Date.parse(rows[0].collectedAt) - 3600_000).toISOString();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: plan.version, enabled: false, startsAt: start } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(start) + 49 * 3600_000 });
  const frozen = (await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start } })).json().batch;
  frozenBatchId = frozen.id;
  const snapshot = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.id}/materials`, headers })).json();
  assert.equal(snapshot.total, 2);
  assert.ok(snapshot.rows.every((row: { source: { work: unknown } }) => JSON.stringify(row.source.work) === JSON.stringify(ref)));
  const changed = await app.inject({ method: "PUT", url: `${path}/${work.id}`, headers, payload: { version: 1, title: "重新确认的作品", materialIds: [ids[0]] } });
  assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().work.version, 2);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${ids[1]}`, headers })).json().source.work, undefined);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.id}/materials`, headers })).json(), snapshot);
  transport.assertNoPendingInterceptors();
});

test("旧窗口和其他作品的成员不能被覆盖，非法或缺失材料使整次操作不变", async () => {
  const rows = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows;
  const assigned = rows.find((row: { source: { work?: unknown } }) => row.source.work), free = rows.find((row: { source: { work?: unknown } }) => !row.source.work);
  const path = "/api/admin/studio/creator-works", work = assigned.source.work;
  const read = async () => (await app.inject({ url: `/api/admin/studio/intelligence/${assigned.id}/work`, headers })).json();
  const before = await read();
  assert.equal((await app.inject({ method: "PUT", url: `${path}/${work.id}`, headers, payload: { version: 1, title: "旧窗口", materialIds: [free.id] } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { title: "不能抢走另一组成员", materialIds: rows.map((row: { id: string }) => row.id) } })).statusCode, 409);
  for (const ids of [[free.id, free.id], [free.id, "news:unsupported"], [free.id], [free.id, "creator:not-a-uuid"]])
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { title: "无效关联", materialIds: ids } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: `${path}/${work.id}`, headers,
    payload: { version: work.version, title: "不能部分保存", materialIds: [free.id, "creator:00000000-0000-0000-0000-000000000000"] } })).statusCode, 409);
  assert.deepEqual(await read(), before);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${free.id}/work`, headers })).json().work, null);
});

test("分析使用冻结的同作品身份与重复解释，不因后来解除关联而回填新状态", async t => {
  transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  const provider = await stub((_hit, request) => {
    const input = JSON.parse(request.body); requests.push(input);
    const material = JSON.parse(input.messages[1].content).material;
    return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "分镜衔接方法", reason: "可核对具体工作流",
      viewerBenefit: "比较镜头衔接步骤", event: "制作流程", evidenceQuotes: [material.body], entities: [],
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
      insights: { commentFocus: [], impacts: [] } }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
  });
  const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const, saved = keys.map(key => process.env[key]);
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-work-key", LLM_MODEL: "isolated-work-model" });
  t.after(async () => { await provider.close(); keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }); });
  const submitted = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${frozenBatchId}/analysis`, headers, payload: {} });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.topic.material-analysis")!, boss = await getBoss();
  for (let n = 0; n < submitted.json().queuedCount; n++) { const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); }
  assert.ok(requests.length > 0);
  for (const request of requests) {
    const material = JSON.parse(request.messages[1]!.content).material;
    assert.deepEqual(material.source.work, { id: frozenWorkId, title: "角色参考与镜头衔接", version: 1, publicationCount: 2 });
    assert.match(material.workIdentityInterpretation, /不是多个独立创作或事实验证/);
  }
});

test("桌面从情报详情搜索关联发布、分别查看表现和解除，窄屏编辑无横向溢出", async () => {
  const rows = (await app.inject({ url: "/api/admin/studio/intelligence?origin=creators", headers })).json().rows;
  assert.equal(rows.length, 2);
  const old = rows.find((row: { source: { work?: unknown } }) => row.source.work).source.work;
  assert.equal((await app.inject({ method: "PUT", url: `/api/admin/studio/creator-works/${old.id}`, headers,
    payload: { version: old.version, title: old.title, materialIds: [] } })).statusCode, 200);
  const current = rows.find((row: { source: { platform: string } }) => row.source.platform === "bilibili"), other = rows.find((row: { source: { platform: string } }) => row.source.platform === "weibo");
  transport.enableNetConnect(/^127\.0\.0\.1:\d+$/);
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + '/admin/login'); await page.locator('input[name="password"]').fill("source-resource-password");
    await page.locator('button[type="submit"]').click();
    await page.goto(web.origin + `/admin/studio/intelligence/${encodeURIComponent(current.id)}`);
    const panel = page.getByRole("region", { name: "同作品跨平台关联" });
    await panel.getByRole("button", { name: "关联同作品发布", exact: true }).click();
    await panel.getByLabel("作品名称", { exact: true }).fill("角色参考跨平台演示");
    await panel.getByText("添加同作品的其他发布", { exact: true }).click();
    await panel.getByRole("textbox", { name: "搜索同作品发布", exact: true }).fill(other.source.name);
    await panel.getByRole("button", { name: "搜索或读取", exact: true }).click();
    await panel.getByRole("button", { name: "选择这条发布", exact: true }).click();
    await panel.getByRole("button", { name: "保存同作品关联", exact: true }).click();
    await expect(panel.getByText("角色参考跨平台演示 · 已关联 2 条发布", { exact: true })).toBeVisible();
    await panel.getByText("展开各平台表现（2 条）", { exact: true }).click();
    await expect(panel.getByText(/B站 · 影视流程研究/)).toBeVisible(); await expect(panel.getByText(/微博 · 影视工具观察/)).toBeVisible();
    await expect(panel.getByRole("link", { name: "查看情报", exact: true })).toHaveCount(2);
    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({ path: ".impeccable/review/creator-works-desktop.png", fullPage: true });
    await panel.getByRole("button", { name: "管理同作品关联", exact: true }).click();
    const selected = panel.getByRole("list", { name: "准备关联的发布", exact: true });
    await selected.getByRole("button", { name: `移除关联：${other.title}`, exact: true }).click();
    await panel.getByRole("button", { name: "保存同作品关联", exact: true }).click();
    await expect(panel.getByText("角色参考跨平台演示 · 已关联 1 条发布", { exact: true })).toBeVisible();
    assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${other.id}/work`, headers })).json().work, null);
    assert.equal((await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().total, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "管理同作品关联", exact: true }).click();
    await panel.getByLabel("作品名称", { exact: true }).fill("角色参考与镜头衔接的跨平台演示".repeat(6));
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/creator-works-mobile.png", fullPage: true });
    page.once("dialog", dialog => dialog.accept());
    await panel.getByRole("button", { name: "放弃修改并刷新", exact: true }).click();
    await expect(panel.getByRole("button", { name: "管理同作品关联", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "管理同作品关联", exact: true }).click();
    await expect(panel.getByLabel("作品名称", { exact: true })).toHaveValue("角色参考跨平台演示");
  } finally { await browser.close(); await web.stop(); }
});
