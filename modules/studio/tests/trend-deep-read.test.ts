import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, QueueDeferred } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const provider = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  return { choices: [{ message: { content: JSON.stringify({ decision: "relevant", reason: "与角色和分镜制作有关，需取得原文", titleQuote: input.signal.title, viewerProblem: "角色一致性制作方法" }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-trend-deep-read", LLM_MODEL: "isolated-quality" });
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
const module = SERVER_MODULES.find(module => module.name === "studio")!;
async function run(name: string, all = false) {
  const queue = module.queues!.find(queue => queue.name === name)!; assert.ok(queue);
  const boss = await getBoss(), jobs = await boss.fetch(name, { batchSize: all ? 10 : 1 }); assert.ok(jobs.length);
  for (const job of jobs) { await queue.run([job.data] as never[]); await boss.complete(name, job.id); }
}

test("相关热榜按独立每日额度自动深读，复用私有作品且不关注作者，材料保留实际热榜出处", async () => {
  const settings = "/api/admin/studio/trends/deep-read-settings";
  assert.equal((await app.inject({ url: settings })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: settings, headers, payload: { version: 0, enabled: true, dailyLimit: 1 } })).statusCode, 200);
  config.modelCallsEnabled = true;
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili", headers, payload: {} });
  const board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } })).statusCode, 200);
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, { code: 0, data: { list: [
    { bvid: "BV10411c7mD8", title: "AI视频角色一致性方法", stat: { view: 10000 } }, { bvid: "BV11411c7mD8", title: "AI漫剧分镜制作教程", stat: { view: 20000 } },
  ] } });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} })).statusCode, 200);
  await run("studio.trends.collect");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} })).statusCode, 200); await run("studio.trends.relevance", true);
  const path = "/api/admin/studio/trends/deep-read";
  const queued = await app.inject({ method: "POST", url: path, headers, payload: {} }); assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().queuedCount, 1); assert.equal(queued.json().limitedCount, 1);
  const quota = (await app.inject({ url: settings, headers })).json(); assert.equal(quota.usedToday, 1); assert.equal(quota.remainingToday, 0);
  const repeated = (await app.inject({ method: "POST", url: path, headers, payload: {} })).json(); assert.equal(repeated.queuedCount, 0);
  const pending = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows;
  const signal = pending.find((row: { deepRead: unknown }) => !!row.deepRead); assert.ok(signal); assert.equal(signal.deepRead.state, "queued");
  const bvid = new URL(signal.url).pathname.split("/").at(-1)!;
  const api = transport.get("https://api.bilibili.com");
  api.intercept({ path: /^\/x\/web-interface\/view\/detail\?/ }).reply(200, { code: 0, data: { View: { aid: 12345, bvid, title: "具体的角色参考与镜头检查步骤", desc: "先固定参考，再检查连续镜头。", owner: { mid: 20813884, name: "影视流程研究" }, pages: [{ cid: 666 }], stat: { view: 12000 } } } });
  api.intercept({ path: "/x/web-interface/nav" }).reply(200, { code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  api.intercept({ path: /^\/x\/player\/wbi\/playurl\?/ }).reply(200, { code: 0, data: { durl: [{ url: "https://upos-sz.example.bilivideo.com/fixture-video.mp4", size: 1000 }] } });
  api.intercept({ path: /^\/x\/player\/wbi\/v2\?/ }).reply(200, { code: 0, data: { subtitle: { subtitles: [] } } });
  await run("studio.content.import");
  const current = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { id: string }) => row.id === signal.id);
  assert.equal(current.deepRead.state, "awaiting_transcript"); assert.match(current.deepRead.materialId, /^creator:/);
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${current.deepRead.materialId}`, headers })).json();
  assert.equal(material.trends[0].id, signal.id); assert.equal(material.trends[0].observations[0].rank, signal.observations[0].rank);
  assert.equal(material.bodyState, "not_transcribed"); assert.equal(material.title, "具体的角色参考与镜头检查步骤");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?origin=trends", headers })).json().total, 1);
  transport.assertNoPendingInterceptors();
});

test("深读任务终止不冒充仍在处理，显式恢复保留额度，来源暂停后不发平台请求且恢复可继续", async () => {
  const settings = "/api/admin/studio/trends/deep-read-settings", before = (await app.inject({ url: settings, headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: settings, headers, payload: { version: before.version, enabled: true, dailyLimit: 2 } })).statusCode, 200);
  const submit = (retryFailed = false) => app.inject({ method: "POST", url: "/api/admin/studio/trends/deep-read", headers, payload: { retryFailed } });
  assert.equal((await submit()).json().queuedCount, 1);
  const boss = await getBoss(), [old] = await boss.fetch("studio.content.import"); assert.ok(old); await boss.fail("studio.content.import", old.id);
  const failed = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { deepRead: { state: string } | null }) => row.deepRead?.state === "failed");
  assert.ok(failed, "终止且未保存原文的任务必须显示失败");
  assert.equal((await submit(true)).json().queuedCount, 1);
  let board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: false } })).statusCode, 200);
  await run("studio.content.import");
  const interrupted = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { id: string }) => row.id === failed.id);
  assert.equal(interrupted.deepRead.state, "interrupted"); assert.equal(interrupted.deepRead.materialId, null);
  board = (await app.inject({ url: "/api/admin/studio/trends/boards", headers })).json().rows.find((row: { platform: string }) => row.platform === "bilibili");
  await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${board.source.id}/status`, headers, payload: { version: board.source.version, enabled: true } });
  assert.equal((await submit()).json().queuedCount, 1);
  assert.equal((await app.inject({ url: settings, headers })).json().usedToday, 2);
  const queue = module.queues!.find(queue => queue.name === "studio.content.import")!; await queue.run([old.data] as never[]);
  const recovered = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { id: string }) => row.id === failed.id);
  assert.equal(recovered.deepRead.state, "queued"); transport.assertNoPendingInterceptors();
  const repeatedRetry = await submit(true);
  assert.equal(repeatedRetry.statusCode, 200, "批量重试应跳过仍在等待的任务，不能阻塞其他线索");
  assert.equal(repeatedRetry.json().queuedCount, 0);
});

test("热榜出处随两日材料冻结，之后的榜单变化不改写发现记录或旧批次", async t => {
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: false, startsAt: current.startsAt } })).statusCode, 200);
  await resources.warm();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(current.endsAt) });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: current.startsAt } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  const path = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`;
  const material = (await app.inject({ url: path, headers })).json().rows.find((row: { trends?: unknown[] }) => row.trends?.length);
  assert.ok(material, "已经取得的作品及真实榜单出处应进入本批完整快照");
  const signal = material.trends[0], bvid = new URL(signal.url).pathname.split("/").at(-1);
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, { code: 0, data: { list: [
    { bvid: "BV12411c7mD8", title: "另一条榜单内容", stat: {} }, { bvid, title: signal.title, stat: { view: 99999 } },
  ] } });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} })).statusCode, 200);
  await run("studio.trends.collect");
  const updated = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { id: string }) => row.id === signal.id);
  assert.equal(updated.observations.at(-1).rank, 2);
  assert.deepEqual((await app.inject({ url: path, headers })).json().rows.find((row: { id: string }) => row.id === material.id), material);
  const live = (await app.inject({ url: `/api/admin/studio/intelligence/${material.id}`, headers })).json();
  assert.deepEqual(live.trends, material.trends);
  transport.assertNoPendingInterceptors();
});

test("已关注博主有待处理作品时，热榜深读保留原任务等待而不发出平台请求", async () => {
  const followed = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(followed.statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${followed.json().creator.id}/collect`, headers, payload: {} })).statusCode, 200);
  const boss = await getBoss(), [job] = await boss.fetch("studio.content.import"); assert.ok(job);
  const queue = module.queues!.find(queue => queue.name === "studio.content.import")!;
  await assert.rejects(queue.run([job.data] as never[]), QueueDeferred);
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { deepRead?: { state: string; materialId: string | null } }) => row.deepRead?.state === "running");
  assert.ok(signal); assert.equal(signal.deepRead.materialId, null);
  assert.equal((await boss.getJobById("studio.content.import", job.id))!.retryCount, 0);
  transport.assertNoPendingInterceptors();
});

test("先免费关联手动任务、次日首次热榜重排时计入当日额度，已付额度的重试不再收费", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T04:00:00Z") });
  const settingsPath = "/api/admin/studio/trends/deep-read-settings", submitPath = "/api/admin/studio/trends/deep-read";
  const settings = (await app.inject({ url: settingsPath, headers })).json();
  await app.inject({ method: "PUT", url: settingsPath, headers, payload: { version: settings.version, enabled: true, dailyLimit: 1 } });
  const bvid = "BV13411c7mD8";
  const manual = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: `https://www.bilibili.com/video/${bvid}` } });
  assert.equal(manual.statusCode, 200);
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/popular" }).reply(200, { code: 0, data: { list: [
    { bvid, title: "AI影视角色参考流程", stat: {} },
  ] } });
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/boards/bilibili/check", headers, payload: {} }); await run("studio.trends.collect");
  await app.inject({ method: "POST", url: "/api/admin/studio/trends/relevance", headers, payload: {} }); await run("studio.trends.relevance", true);
  assert.equal((await app.inject({ method: "POST", url: submitPath, headers, payload: {} })).statusCode, 200);
  const signal = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { url: string }) => row.url.includes(bvid));
  assert.equal(signal.deepRead.charged, false);
  const boss = await getBoss(), jobs = await boss.fetch("studio.content.import", { batchSize: 10 });
  const job = jobs.find(job => (job.data as { id: string }).id === manual.json().item.id); assert.ok(job); await boss.fail("studio.content.import", job.id);
  t.mock.timers.setTime(new Date("2026-11-02T04:00:00Z").getTime());
  const retry = await app.inject({ method: "POST", url: submitPath, headers, payload: { retryFailed: true } });
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().queuedCount, 1);
  const today = (await app.inject({ url: settingsPath, headers })).json();
  assert.equal(today.day, "2026-11-02"); assert.equal(today.usedToday, 1); assert.equal(today.remainingToday, 0);
  const charged = (await app.inject({ url: "/api/admin/studio/trends/signals", headers })).json().rows.find((row: { id: string }) => row.id === signal.id);
  assert.equal(charged.deepRead.budgetDay.slice(0, 10), "2026-11-02"); assert.equal(charged.deepRead.charged, true);
  const [second] = await boss.fetch("studio.content.import"); assert.ok(second); await boss.fail("studio.content.import", second.id);
  t.mock.timers.setTime(new Date("2026-11-03T04:00:00Z").getTime());
  assert.equal((await app.inject({ method: "POST", url: submitPath, headers, payload: { retryFailed: true } })).json().queuedCount, 1);
  assert.equal((await app.inject({ url: settingsPath, headers })).json().usedToday, 0);
  transport.assertNoPendingInterceptors();
});
