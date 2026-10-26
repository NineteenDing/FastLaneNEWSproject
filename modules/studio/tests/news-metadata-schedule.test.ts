import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
const read = async (id: string) => (await app.inject({ url: `/api/admin/studio/news-sources?q=${id}`, headers })).json().rows[0];
async function create(id: string, enabled = true, kind = "web_list") {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id, name: id, kind, enabled, config: kind === "web_list" ? { url: `https://${id}.example/news`, itemSelector: "article" } : {} } })).statusCode, 200);
}
async function waitUntil(ready: () => Promise<boolean>) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) { if (await ready()) return; await delay(40); }
  assert.fail("新闻资料任务未在期限内完成");
}

test("启用的新闻源经持久定时任务补全本地资料，重复调度和页面读取不重复抓取，暂停来源不入队", { timeout: 20_000 }, async () => {
  const schedule = studio.schedules?.find(item => item.name === "studio.news.metadata.schedule");
  assert.ok(schedule, "新闻源需要定时资料补全入口");
  assert.equal(schedule.cron, "15 * * * *"); assert.equal(schedule.missed, "once");
  process.env.COLLECT_ENABLED = "false";
  await create("auto-metadata"); await create("paused-metadata", false);
  assert.deepEqual(await schedule.run(), { queued: 0 });
  process.env.COLLECT_ENABLED = "true";
  const results = await Promise.all([schedule.run(), schedule.run()]);
  assert.equal(results.reduce<number>((sum, item) => sum + (item as { queued: number }).queued, 0), 1);
  const queue = studio.queues!.find(item => item.name === "studio.news.metadata")!;
  const boss = await getBoss(), [job] = await boss.findJobs(queue.name, { queued: true }); assert.ok(job);
  let requests = 0;
  transport.get("https://auto-metadata.example").intercept({ path: "/news" }).reply(() => {
    requests++; return { statusCode: 200, data: '<html lang="zh-CN"><meta name="description" content="自动取得的影视资料"><link rel="icon" href="/icon.svg"></html>' };
  });
  transport.get("https://auto-metadata.example").intercept({ path: "/icon.svg" })
    .reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="teal"/></svg>', { headers: { "content-type": "image/svg+xml" } });
  const { createNewsMetadataQueue } = await import("../backend/news-metadata-jobs.ts");
  installModules([{ ...studio, name: "metadata-fixture", queues: [createNewsMetadataQueue(resources)] }]);
  await resources.warm(); const stop = await workModuleQueues(boss);
  try {
    await waitUntil(async () => (await boss.findJobs(queue.name, { id: job.id }))[0]!.state === "completed");
    const card = await read("auto-metadata");
    assert.equal(card.description, "自动取得的影视资料"); assert.equal(card.language, "zh-CN");
    assert.equal(card.region, null); assert.equal(card.lastCheckedAt, null);
    assert.equal(card.metadata.state, "ok"); assert.ok(card.avatarUrl);
    assert.equal((await app.inject({ url: card.avatarUrl })).statusCode, 401);
    assert.equal((await app.inject({ url: card.avatarUrl, headers })).statusCode, 200);
    await read("auto-metadata"); assert.deepEqual(await schedule.run(), { queued: 0 });
    assert.equal(requests, 1); assert.equal((await boss.findJobs(queue.name)).length, 1);
    assert.equal((await read("paused-metadata")).metadata, null);
    transport.assertNoPendingInterceptors();
  } finally { await stop(); }
});

test("低磁盘及全局暂停保留原任务；请求途中暂停不再读头像或发布资料，恢复重启消费者后同ID完成", { timeout: 25_000 }, async () => {
  const schedule = studio.schedules!.find(item => item.name === "studio.news.metadata.schedule")!;
  await create("pause-auto-metadata");
  assert.deepEqual(await schedule.run(), { queued: 1 });
  const queue = studio.queues!.find(item => item.name === "studio.news.metadata")!, boss = await getBoss();
  const [job] = await boss.findJobs(queue.name, { queued: true }); assert.ok(job);
  const control = async (enabled: boolean) => {
    const state = (await app.inject({ url: "/api/admin/studio/collection-operations", headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/collection-operations", headers,
      payload: { version: state.version, enabled } })).statusCode, 200);
  };
  let requests = 0, icons = 0, announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  transport.get("https://pause-auto-metadata.example").intercept({ path: "/news" }).reply(() => {
    requests++; announce(); return { statusCode: 200, data: '<html lang="zh-CN"><meta name="description" content="恢复后取得"><link rel="icon" href="/icon.svg"></html>' };
  }).delay(400).times(2);
  transport.get("https://pause-auto-metadata.example").intercept({ path: "/icon.svg" }).reply(() => {
    icons++; return { statusCode: 200, data: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/></svg>', responseOptions: { headers: { "content-type": "image/svg+xml" } } };
  });
  resources.capacity.diskBytes = 5_500_000_000; await resources.warm();
  let stop = await workModuleQueues(boss);
  try {
    await delay(2200); assert.equal(requests, 0);
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "created");
    await control(false); resources.capacity.diskBytes = 6_100_000_000; await resources.warm();
    await delay(2200); assert.equal(requests, 0);
    await control(true); await started; await control(false); await delay(650);
    assert.equal(icons, 0, "已暂停的自动任务不能在主页返回后继续请求头像");
    assert.equal((await read("pause-auto-metadata")).metadata, null);
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.state, "created");
    assert.deepEqual(await schedule.run(), { queued: 0 });
    await stop(); await control(true); stop = await workModuleQueues(boss); await resources.warm();
    await waitUntil(async () => (await boss.findJobs(queue.name, { id: job.id }))[0]!.state === "completed");
    assert.equal((await read("pause-auto-metadata")).description, "恢复后取得");
    assert.equal((await boss.findJobs(queue.name, { id: job.id }))[0]!.retryCount, 0);
    assert.equal(requests, 2); assert.equal(icons, 1);
    transport.assertNoPendingInterceptors();
  } finally { await stop(); await control(true); }
});

test("成功七天、失败一天退避，缺主页等配置变化；排队后的人工编辑及移除使旧任务安全跳过", { timeout: 25_000 }, async t => {
  const schedule = studio.schedules!.find(item => item.name === "studio.news.metadata.schedule")!;
  for (const id of ["auto-metadata", "pause-auto-metadata"]) {
    const card = await read(id);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
      payload: { version: card.version, patch: { enabled: false } } })).statusCode, 200);
  }
  await create("cadence-good"); await create("cadence-failed"); await create("cadence-home", true, "external");
  transport.get("https://cadence-good.example").intercept({ path: "/news" }).reply(200, '<html lang="zh-CN"><meta name="description" content="可靠资料"></html>');
  transport.get("https://cadence-good.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
  transport.get("https://cadence-failed.example").intercept({ path: "/news" }).reply(503, "upstream-unavailable");
  assert.deepEqual(await schedule.run(), { queued: 3 });
  const boss = await getBoss(), queue = studio.queues!.find(item => item.name === "studio.news.metadata")!;
  const firstJobs = await boss.findJobs(queue.name, { queued: true });
  const completed = async (ids: string[]) => {
    const jobs = await boss.findJobs(queue.name);
    return ids.every(id => jobs.some(job => job.id === id && job.state === "completed"));
  };
  await resources.warm(); let stop = await workModuleQueues(boss);
  try {
    await waitUntil(() => completed(firstJobs.map(job => job.id)));
    const good = await read("cadence-good"), failed = await read("cadence-failed"), missing = await read("cadence-home");
    assert.equal(good.metadata.state, "ok"); assert.equal(failed.metadata.state, "failed");
    assert.equal(missing.metadata.state, "needs_homepage"); assert.equal(good.description, "可靠资料");
    await stop();
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(failed.metadata.checkedAt) + 86_400_000 - 1 });
    assert.deepEqual(await schedule.run(), { queued: 0 });
    // API metadata timestamps retain PG microseconds; the test clock has millisecond precision.
    t.mock.timers.tick(2); assert.deepEqual(await schedule.run(), { queued: 1 });
    t.mock.timers.setTime(Date.parse(good.metadata.checkedAt) + 7 * 86_400_000 + 1);
    assert.deepEqual(await schedule.run(), { queued: 1 });
    assert.deepEqual(await schedule.run(), { queued: 0 }, "缺主页不循环排队，已有任务也不重复");
    const pending = await boss.findJobs(queue.name, { queued: true }); assert.equal(pending.length, 2);
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/cadence-failed/profile", headers,
      payload: { version: failed.profileVersion, description: "人工简介", language: null, region: "中国", homepage: "https://cadence-failed.example/" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/sources/cadence-good", headers,
      payload: { version: good.version, patch: { archived: true } } })).statusCode, 200);
    stop = await workModuleQueues(boss); await resources.warm();
    await waitUntil(() => completed(pending.map(job => job.id)));
    assert.equal((await read("cadence-failed")).description, "人工简介");
    assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?q=cadence-good&archived=true", headers })).json().rows[0].description, "可靠资料");
    const home = await read("cadence-home");
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/cadence-home/profile", headers,
      payload: { version: home.profileVersion, description: null, language: null, region: null, homepage: "https://home-added.example/" } })).statusCode, 200);
    await stop();
    assert.deepEqual(await schedule.run(), { queued: 2 }, "手填主页/配置变更失效旧快照，可在下次检查补齐");
    transport.assertNoPendingInterceptors();
  } finally { await stop(); }
});

test("每次最多排20个来源，持久暂停时重启仍登记定时器，恢复后继续余下来源而非丢任务", async () => {
  const schedule = studio.schedules!.find(item => item.name === "studio.news.metadata.schedule")!;
  for (let i = 0; i < 21; i++) await create(`bounded-metadata-${i}`, true, "external");
  const control = (await app.inject({ url: "/api/admin/studio/collection-operations", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/collection-operations", headers,
    payload: { version: control.version, enabled: false } })).statusCode, 200);
  assert.deepEqual(await schedule.run(), { queued: 0 });
  installModules([{ ...studio, queues: [] }]);
  const { registerSchedules } = await import("../../../apps/worker/src/schedules.ts");
  const boss = await getBoss(); await registerSchedules(boss);
  assert.ok((await boss.getSchedules()).some(item => item.name === "cron.studio.news.metadata.schedule"));
  const paused = (await app.inject({ url: "/api/admin/studio/collection-operations", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/collection-operations", headers,
    payload: { version: paused.version, enabled: true } })).statusCode, 200);
  assert.deepEqual(await schedule.run(), { queued: 20 });
  assert.deepEqual(await schedule.run(), { queued: 1 });
  assert.deepEqual(await schedule.run(), { queued: 0 });
});
