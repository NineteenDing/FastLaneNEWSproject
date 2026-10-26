import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, ensureQueue } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { weiboFixture } from "./mediacrawler-fixture.ts";
import { stub } from "../../../tests/setup.ts";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { createCreatorExpressionQueue } from "../backend/creator-expressions.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const bodies = ["先展示角色变化的问题。第一步固定参考图。最后核对相邻镜头。", "先展示分镜衔接的问题。第一步标注镜头。最后检查连续性。"];
const requests: Array<{ messages: Array<{ content: string }> }> = [];
let creatorId = "", invalidQuote = false;
const provider = await stub((_hit, request) => {
  const call = JSON.parse(request.body); requests.push(call);
  const input = JSON.parse(call.messages.at(-1).content);
  return { choices: [{ message: { content: JSON.stringify({ patterns: [{ dimension: "opening", observation: "以具体制作问题进入主题",
    application: "先说明本次制作哪里出了问题，再接操作步骤", possibleEffect: "可能帮助观众辨认是否遇到同类问题，未验证留存因果",
    limitations: "仅有文本，没有实测语音节奏或完整画面", evidence: [
      { materialId: input.materials.find((m: { body: string }) => m.body.includes("先展示角色变化的问题。")).id, quote: invalidQuote ? "保证十倍收益，已证实所有博主的动机" : "先展示角色变化的问题。" },
      { materialId: input.materials.find((m: { body: string }) => m.body === bodies[1]).id, quote: "先展示分镜衔接的问题。" },
    ] }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } };
});
Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-expression-key", LLM_MODEL: "isolated-expression-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("博主表达库保存多作品原文依据，同上下文不重复学习，读取不触发付费", async t => {
  const path = "/api/admin/studio/creators/00000000-0000-0000-0000-000000000000/expressions";
  assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  await resources.warm(); config.modelCallsEnabled = true; config.allowPrivateNetworkFetch = true;
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(transport);
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); });
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } });
  assert.equal(added.statusCode, 200); const id = added.json().creator.id, endpoint = `/api/admin/studio/creators/${id}/expressions`;
  creatorId = id;
  const boss = await getBoss(), collection = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  for (let index = 0; index < 2; index++) {
    weiboFixture(transport, { postId: "530000000000001" + index, text: bodies[index], complete: true });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(collection.name); assert.ok(job); await collection.run([job.data] as never[]); await boss.complete(collection.name, job.id);
  }
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(submitted.statusCode, 200, submitted.body); assert.equal(submitted.json().queued, true);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.expressions")!;
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const read = await app.inject({ url: endpoint, headers }); assert.equal(read.statusCode, 200); assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(read.json().state, "completed"); assert.equal(read.json().library.sources.length, 2);
  assert.equal(read.json().library.patterns[0].dimension, "opening"); assert.equal(read.json().library.patterns[0].evidence.length, 2);
  assert.equal(requests.length, 1);
  const repeated = await app.inject({ method: "POST", url: endpoint, headers, payload: {} }); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().queued, false);
  await app.inject({ url: endpoint, headers }); assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0]!.messages.at(-1)!.content);
  assert.equal(input.materials.length, 2); assert.ok(input.materials.every((m: { bodyState: string }) => m.bodyState === "collected"));
  assert.ok(requests[0]!.messages[0]!.content.includes("不能推断完播率"));
  transport.assertNoPendingInterceptors();
});

test("原文更正后旧表达库标记过期，模型编造依据不替换上次成功结果", async t => {
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(transport);
  t.after(async () => { invalidQuote = false; setGlobalDispatcher(previous); await transport.close(); });
  const endpoint = `/api/admin/studio/creators/${creatorId}/expressions`, before = (await app.inject({ url: endpoint, headers })).json().library;
  weiboFixture(transport, { postId: "5300000000000010", text: bodies[0] + "补充：先核对工具版本。", complete: true });
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} });
  const boss = await getBoss(), collect = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const [job] = await boss.fetch(collect.name); assert.ok(job); await collect.run([job.data] as never[]); await boss.complete(collect.name, job.id);
  assert.equal((await app.inject({ url: endpoint, headers })).json().changedMaterialIds.length, 1);
  invalidQuote = true;
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: {} })).json().queued, true);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.expressions")!;
  const [learning] = await boss.fetch(queue.name); assert.ok(learning);
  await assert.rejects(queue.run([learning.data] as never[]), /表达模式/); await boss.cancel(queue.name, learning.id);
  const failed = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(failed.state, "failed"); assert.deepEqual(failed.library, before);
  assert.equal(failed.changedMaterialIds.length, 1);
  transport.assertNoPendingInterceptors();
});

test("已提交学习后取消关注，后台不再付费并保留上次表达库", async () => {
  const endpoint = `/api/admin/studio/creators/${creatorId}`, calls = requests.length;
  const before = (await app.inject({ url: endpoint + "/expressions", headers })).json().library;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/expressions", headers, payload: { retryFailed: true } })).json().queued, true);
  const account = (await app.inject({ url: endpoint, headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: endpoint + "/archive", headers, payload: { version: account.version, archived: true } })).statusCode, 200);
  try {
    const boss = await getBoss(), queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.expressions")!;
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const read = (await app.inject({ url: endpoint + "/expressions", headers })).json();
    assert.equal(read.state, "superseded"); assert.deepEqual(read.library, before); assert.equal(requests.length, calls);
  } finally {
    const current = (await app.inject({ url: endpoint, headers })).json();
    const restored = (await app.inject({ method: "PATCH", url: endpoint + "/archive", headers, payload: { version: current.version, archived: false } })).json().creator;
    await app.inject({ method: "PATCH", url: endpoint + "/status", headers, payload: { version: restored.version, enabled: true } });
  }
});

test("用户改稿任务优先于自动博主表达学习，待办结束后恢复准入", async () => {
  const queue = createCreatorExpressionQueue({ host: resources.host, disk: resources.disk, database: resources.database });
  const active = queue.admission!();
  await resources.warm(); const boss = await getBoss(); await ensureQueue("studio.writing.revise");
  try {
    assert.equal(await active.canStart(), true);
    const id = await boss.send("studio.writing.revise", { revisionId: "00000000-0000-0000-0000-000000000000" }); assert.ok(id);
    try { assert.equal(await active.canStart(), false); } finally { await boss.cancel("studio.writing.revise", id); }
    assert.equal(await active.canStart(), true);
  } finally { await active.stop(); }
});

test("博主档案显示真实模式依据、更正与缺口，桌面窄屏可读，刷新和样本不足都不调用模型", async () => {
  config.siteUrl = "http://127.0.0.1";
  const web = await startWebServer(app.server), browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), calls = requests.length;
  await mkdir(".impeccable/review", { recursive: true });
  try {
    await page.goto(web.origin + `/admin/studio/creators/${creatorId}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "博主档案", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "影视工具观察", exact: true })).toBeVisible();
    await expect(page.getByText("1 份依据已更正", { exact: false })).toBeVisible();
    await page.getByText("查看依据与限制（2 份作品）", { exact: true }).click();
    await expect(page.getByText("先展示角色变化的问题。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "刷新档案", exact: true }).click();
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/creator-expression-profile-${suffix}.png`, fullPage: true });
    }
    const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/930000111" } });
    assert.equal(added.statusCode, 200);
    await page.goto(web.origin + `/admin/studio/creators/${added.json().creator.id}`);
    await expect(page.getByText("尚无已完成的表达模式", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "学习最新表达样本", exact: true }).click();
    await expect(page.getByText("至少需要两份完整正文或已转写视频，当前尚不足", { exact: true })).toBeVisible();
    assert.equal(requests.length, calls);
    await page.getByRole("link", { name: "返回博主关注", exact: true }).click();
    await expect(page.getByRole("link", { name: "博主档案与表达模式", exact: true })).toHaveCount(2);
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
