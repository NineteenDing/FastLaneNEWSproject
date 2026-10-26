import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { setTimeout as delay } from "node:timers/promises";
import { createTopicFreezeQueue } from "../backend/topic-jobs.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("自动截止默认关闭，到点只提交一个持久补收任务，多次触发不重复排队，网页读取不触发任务", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T11:59:59.999Z") });
  const schedule = studio.schedules?.find(item => item.name === "studio.topic.schedule");
  assert.ok(schedule, "两日截止需要后台定时入口");
  assert.equal(schedule.cron, "* * * * *");
  assert.equal(schedule.missed, "once");
  const boss = await getBoss();
  assert.deepEqual(await schedule.run(), { queued: false });
  const saved = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: true, startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(await schedule.run(), { queued: false });
  await app.inject({ url: "/api/admin/studio/topic-batches/current", headers });
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime());
  const results = await Promise.all([schedule.run(), schedule.run()]);
  assert.equal(results.filter(result => (result as { queued: boolean }).queued).length, 1);
  const pending = await boss.findJobs("studio.topic.freeze", { queued: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.state, "created");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("低于6GB时积压保持原任务，消费者重启恢复后逐期冻结，一次只处理一个相邻窗口且不重复材料", { timeout: 30_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T12:00:00Z") });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "scheduled-news", name: "定时选题来源", kind: "rss", config: { feedUrl: "https://scheduled.example/feed" } } })).statusCode, 200);
  for (const [day, title] of [[17, "十七日角色一致性"], [19, "十九日镜头运动"], [21, "二十一日新模型"], [23, "二十三日实际成本"]] as const)
    await upsertMaterial({ sourceId: "scheduled-news", title, url: `https://scheduled.example/${day}`, via: "import",
      discoveredAt: new Date(`2026-10-${day}T10:00:00Z`), bodyText: "操作依据完整保存", bodyStatus: "ok" });
  const queue = createTopicFreezeQueue(resources.host, resources.disk, resources.database);
  installModules([{ ...studio, name: "topic-schedule-fixture", queues: [queue] }]);
  const boss = await getBoss();
  const pending = (await boss.findJobs(queue.name, { queued: true }))[0]!;
  assert.ok(pending.id);
  resources.capacity.diskBytes = 5_000_000_000;
  let stop = await workModuleQueues(boss);
  try {
    await resources.warm();
    await delay(2200);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "created");
    assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
    await stop();
    resources.capacity.diskBytes = 6_000_000_000;
    stop = await workModuleQueues(boss);
    await resources.warm();
    const waitUntil = async (ready: () => Promise<boolean>) => {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) { if (await ready()) return; await delay(30); }
      assert.fail("两日冻结任务未在截止前完成");
    };
    await waitUntil(async () => (await boss.findJobs(queue.name, { id: pending.id }))[0]!.state === "completed");
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0);
    assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 1);
    const schedule = studio.schedules!.find(item => item.name === "studio.topic.schedule")!;
    for (const count of [2, 3, 4]) {
      assert.deepEqual(await schedule.run(), { queued: true });
      await waitUntil(async () => (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total === count);
    }
    const batches = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().rows;
    assert.deepEqual(batches.map((batch: { startsAt: string }) => batch.startsAt), [
      "2026-10-22T12:00:00.000Z", "2026-10-20T12:00:00.000Z", "2026-10-18T12:00:00.000Z", "2026-10-16T12:00:00.000Z"]);
    const titles: string[] = [];
    for (const batch of batches) {
      assert.equal(batch.materialCount, 1); assert.equal(batch.recommendationState, "not_generated");
      assert.equal(batch.adoptionState, "not_adopted");
      const evidence = (await app.inject({ url: `/api/admin/studio/topic-batches/${batch.id}/materials`, headers })).json();
      titles.push(evidence.rows[0].title);
    }
    assert.deepEqual(titles, ["二十三日实际成本", "二十一日新模型", "十九日镜头运动", "十七日角色一致性"]);
    assert.deepEqual(await schedule.run(), { queued: false });
  } finally { await stop(); }
});

test("截止后暂停计划使已排队消息安全结束，恢复后从原窗口继续，关闭采集不移除两日定时器", { timeout: 20_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") });
  const schedule = studio.schedules!.find(item => item.name === "studio.topic.schedule")!;
  assert.deepEqual(await schedule.run(), { queued: true });
  const paused = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 1, enabled: false, startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(paused.statusCode, 200);
  const queue = createTopicFreezeQueue(resources.host, resources.disk, resources.database);
  installModules([{ ...studio, name: "topic-schedule-fixture", queues: [queue], schedules: [schedule] }]);
  const boss = await getBoss(), pending = (await boss.findJobs(queue.name, { queued: true }))[0]!;
  const stop = await workModuleQueues(boss);
  const previous = process.env.COLLECT_ENABLED; process.env.COLLECT_ENABLED = "false";
  try {
    await resources.warm();
    const { registerSchedules } = await import("../../../apps/worker/src/schedules.ts");
    await registerSchedules(boss);
    assert.ok((await boss.getSchedules()).some(item => item.name === "cron.studio.topic.schedule"));
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && (await boss.findJobs(queue.name, { id: pending.id }))[0]!.state !== "completed") await delay(30);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "completed");
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0);
    assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 4);
    assert.deepEqual(await schedule.run(), { queued: false });
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
      payload: { version: 2, enabled: true, startsAt: "2026-10-16T12:00:00Z" } })).statusCode, 200);
    assert.deepEqual(await schedule.run(), { queued: true });
    const resumed = performance.now() + 5000;
    while (performance.now() < resumed && (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total !== 5) await delay(30);
    const latest = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json();
    assert.equal(latest.total, 5); assert.equal(latest.rows[0].startsAt, "2026-10-24T12:00:00.000Z");
  } finally {
    await stop();
    if (previous === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = previous;
  }
});
