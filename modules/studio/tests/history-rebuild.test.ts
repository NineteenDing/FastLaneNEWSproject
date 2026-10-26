import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { createSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { getBoss, stopBoss, enqueue, QUEUES, workModuleQueues } from "@aihot/backend/jobs/queue";
import { setTimeout as delay } from "node:timers/promises";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { studio } from "../server.ts";
import { createHistoryRebuildQueue } from "../backend/history-rebuild.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// Real engine/import lifecycle before Studio is installed, as with an existing restored installation.
installModules([]);
await createSource({ id: "legacy-history", name: "已有制作新闻", kind: "rss", config: { feedUrl: "https://legacy.example/feed" } }, "test:legacy-import");
for (let index = 0; index < 51; index++) await upsertMaterial({ sourceId: "legacy-history", title: `LegacyHistoryMarker ${index}`,
  url: `https://legacy.example/${index}`, via: "import", bodyText: "可灵参考图的制作条件", bodyStatus: "ok" });
const resources = await sourceResourceFixture(), { app, headers } = resources;
const previousTransport = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
const following = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
assert.equal(following.statusCode, 200);
bilibiliFixture(transport, { description: "CreatorRebuildMarker：有依据的制作步骤" });
assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${following.json().creator.id}/collect`, headers, payload: {} })).statusCode, 200);
const creatorQueue = studio.queues!.find(queue => queue.name === "studio.creator.collect")!, seedBoss = await getBoss();
const [creatorJob] = await seedBoss.fetch(creatorQueue.name); assert.ok(creatorJob);
await creatorQueue.run([creatorJob.data] as never[]); await seedBoss.complete(creatorQueue.name, creatorJob.id);
transport.assertNoPendingInterceptors();
after(async () => { setGlobalDispatcher(previousTransport); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("已有原引擎材料可分批补建私有索引，重复提交复用任务，读取不自动建索引", async () => {
  const url = "/api/admin/studio/history-index";
  assert.equal((await app.inject({ url })).statusCode, 401);
  const before = await app.inject({ url, headers }); assert.equal(before.statusCode, 200);
  assert.equal(before.headers["cache-control"], "no-store");
  assert.equal(before.json().state, "not_started"); assert.equal(before.json().processed, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/history?q=LegacyHistoryMarker", headers })).json().rows.length, 0);
  const schedule = studio.schedules?.find(item => item.name === "studio.history.schedule"); assert.ok(schedule);
  assert.equal(schedule.missed, "once");
  const submitted = await Promise.all([schedule.run(), ...[1, 2].map(async () => {
    const result = await app.inject({ method: "POST", url, headers, payload: {} }); assert.equal(result.statusCode, 200); return result.json();
  })]);
  assert.equal(submitted.filter(result => (result as { queued: boolean }).queued).length, 1);
  assert.equal(new Set(submitted.map(result => (result as { runId: string }).runId)).size, 1);
  const queue = studio.queues!.find(queue => queue.name === "studio.history.rebuild"); assert.ok(queue);
  const boss = await getBoss(); assert.equal((await boss.findJobs(queue.name, { queued: true })).length, 1);
  const waiting = (await app.inject({ url, headers })).json(); assert.equal(waiting.state, "queued"); assert.equal(waiting.processed, 0);
});

test("补建历史在采集待办之后运行，不抢占正常来源采集", async () => {
  const queue = createHistoryRebuildQueue(resources.host, resources.disk, resources.database), gate = queue.admission!();
  const boss = await getBoss(), priority = await enqueue(QUEUES.fetchSource, { sourceId: "legacy-history" }); assert.ok(priority);
  try {
    await resources.warm(); assert.equal(await gate.canStart(), false);
    await boss.cancel(QUEUES.fetchSource, priority); assert.equal(await gate.canStart(), true);
  } finally { await boss.cancel(QUEUES.fetchSource, priority); await gate.stop(); }
});

test("一次补建途中数据库拒写会回滚整批和游标，明确重试后仍从未完成位置开始", async () => {
  const queue = createHistoryRebuildQueue(resources.host, resources.disk, resources.database), gate = queue.admission!();
  const boss = await getBoss(); await resources.warm();
  const [job] = await boss.fetch(queue.name); assert.ok(job);
  await sql.unsafe(`CREATE FUNCTION test_reject_history_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF (SELECT count(*) FROM studio_history_index) >= 2 THEN RAISE EXCEPTION 'history-batch-storage-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER test_history_batch BEFORE INSERT OR UPDATE ON studio_history_index FOR EACH ROW EXECUTE FUNCTION test_reject_history_batch()");
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/history-index", headers })).json().state, "running");
    await assert.rejects(queue.run([job.data] as never[]), /history-batch-storage-refused/);
    await boss.fail(queue.name, job.id);
    const status = (await app.inject({ url: "/api/admin/studio/history-index", headers })).json();
    assert.equal(status.state, "failed"); assert.equal(status.processed, 0);
    assert.equal((await app.inject({ url: "/api/admin/studio/history?q=LegacyHistoryMarker", headers })).json().rows.length, 0);
    assert.equal((await studio.schedules!.find(item => item.name === "studio.history.schedule")!.run() as { queued: boolean }).queued, false);
  } finally {
    await sql.unsafe("DROP TRIGGER test_history_batch ON studio_history_index");
    await sql.unsafe("DROP FUNCTION test_reject_history_batch()"); await gate.stop();
  }
  const retry = await app.inject({ method: "POST", url: "/api/admin/studio/history-index", headers, payload: { retryFailed: true } });
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().queued, true);
});

test("每次最多补建50条，实际消费者低于6GB保留原任务，恢复后从检查点继续且不需外发许可", { timeout: 30_000 }, async () => {
  const queue = createHistoryRebuildQueue(resources.host, resources.disk, resources.database);
  const gate = queue.admission!();
  try {
    await resources.warm(); assert.equal(await gate.canStart(), true);
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    // Real PostgreSQL read latency: hold the status statement's snapshot while a batch commits.
    await sql.unsafe(`CREATE FUNCTION test_delay_history_snapshot(value text) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN IF pg_try_advisory_xact_lock(876543210) THEN PERFORM pg_sleep(2); END IF; RETURN value; END $$`);
    await sql.unsafe("ALTER TABLE studio_history_rebuild RENAME TO test_history_rebuild_storage");
    await sql.unsafe(`CREATE VIEW studio_history_rebuild AS SELECT scope, id, test_delay_history_snapshot(policy) AS policy,
      state, phase, news_upper, creator_upper, cursor, processed, job_id, error, created_at, updated_at, completed_at FROM test_history_rebuild_storage`);
    const reading = app.inject({ url: "/api/admin/studio/history-index", headers });
    try {
      const deadline = performance.now() + 1500;
      let waiting = false;
      while (!waiting && performance.now() < deadline) {
        const [activity] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%studio_history_rebuild%') AS waiting`;
        waiting = activity!.waiting; if (!waiting) await delay(10);
      }
      assert.equal(waiting, true, "状态读取应已进入真实PG延迟窗口");
      await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
      const snapshot = await reading; assert.equal(snapshot.statusCode, 200);
      assert.notEqual(snapshot.json().state, "failed", "正常续批不能混用旧检查点与已完成消息误报失败");
    } finally {
      await reading;
      await sql.unsafe("DROP VIEW studio_history_rebuild");
      await sql.unsafe("ALTER TABLE test_history_rebuild_storage RENAME TO studio_history_rebuild");
      await sql.unsafe("DROP FUNCTION test_delay_history_snapshot(text)");
    }
    const progress = (await app.inject({ url: "/api/admin/studio/history-index", headers })).json();
    assert.equal(progress.processed, 50); assert.equal(progress.state, "queued");
    assert.equal((await app.inject({ url: "/api/admin/studio/history?q=LegacyHistoryMarker", headers })).json().coverage, "incremental_only");
    // A cancelled/missing consumer must not leave the UI permanently claiming it is running.
    const [interrupted] = await boss.findJobs(queue.name, { queued: true }); assert.ok(interrupted);
    await boss.cancel(queue.name, interrupted.id);
    const failure = (await app.inject({ url: "/api/admin/studio/history-index", headers })).json();
    assert.equal(failure.state, "failed"); assert.equal(failure.processed, 50); assert.ok(failure.error);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/history-index", headers, payload: {} })).statusCode, 409);
    const retry = await app.inject({ method: "POST", url: "/api/admin/studio/history-index", headers, payload: { retryFailed: true } });
    assert.equal(retry.statusCode, 200); assert.equal(retry.json().queued, true); assert.equal(retry.json().runId, progress.runId);
    // Replaying an already committed checkpoint cannot enqueue another branch or redo a batch.
    await queue.run([job.data] as never[]);
    assert.equal((await app.inject({ url: "/api/admin/studio/history-index", headers })).json().processed, 50);
    assert.equal((await boss.findJobs(queue.name, { queued: true })).length, 1);
    await gate.stop();
    installModules([{ ...studio, queues: [queue] }]);
    const original = { collect: process.env.COLLECT_ENABLED, model: process.env.MODEL_CALLS_ENABLED, modelCalls: config.modelCallsEnabled };
    process.env.COLLECT_ENABLED = process.env.MODEL_CALLS_ENABLED = "false";
    config.modelCallsEnabled = false;
    resources.capacity.diskBytes = 5_000_000_000;
    let stop = await workModuleQueues(boss);
    try {
      await resources.warm(); await delay(5200);
      const [pending] = await boss.findJobs(queue.name, { queued: true }); assert.ok(pending);
      assert.equal(pending.state, "created"); assert.equal(pending.retryCount, 0);
      assert.equal((await app.inject({ url: "/api/admin/studio/history-index", headers })).json().processed, 50);
      await stop(); resources.capacity.diskBytes = 6_000_000_000;
      stop = await workModuleQueues(boss); await resources.warm();
      const deadline = performance.now() + 16_000;
      while (performance.now() < deadline && (await app.inject({ url: "/api/admin/studio/history-index", headers })).json().state !== "completed") await delay(40);
      assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "completed");
      assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0);
    } finally {
      await stop(); resources.capacity.diskBytes = 20 * 1024 ** 3;
      config.modelCallsEnabled = original.modelCalls;
      for (const [key, value] of [["COLLECT_ENABLED", original.collect], ["MODEL_CALLS_ENABLED", original.model]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const completed = (await app.inject({ url: "/api/admin/studio/history-index", headers })).json();
    assert.equal(completed.processed, 52); assert.equal(completed.state, "completed"); assert.equal(completed.phase, "done");
    assert.equal(typeof completed.completedAt, "string");
    const found = (await app.inject({ url: "/api/admin/studio/history?q=LegacyHistoryMarker&limit=50", headers })).json();
    assert.equal(found.rows.length, 50); assert.equal(found.coverage, "backfilled");
    const creator = (await app.inject({ url: "/api/admin/studio/history?q=CreatorRebuildMarker", headers })).json();
    assert.equal(creator.rows.length, 1); assert.equal(creator.rows[0].kind, "video"); assert.equal(creator.rows[0].source.platform, "bilibili");
    const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/history-index", headers, payload: {} });
    assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, false); assert.equal(submitted.json().runId, completed.runId);
    assert.equal((await boss.findJobs(queue.name, { queued: true })).length, 0);
    assert.equal((await studio.schedules!.find(item => item.name === "studio.history.schedule")!.run() as { queued: boolean }).queued, false);
  } finally { await gate.stop(); }
});
