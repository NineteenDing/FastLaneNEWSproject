import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { defineQueue, installModules } from "@aihot/backend/modules";
import { enqueueOn, getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";

after(async () => { await stopBoss(); await closeDb(); });

test("两个独立数据库连接池的受控worker仍遵守同组全局串行限制", async () => {
  let active = 0, peak = 0, executions = 0;
  const queue = defineQueue({ name: "studio.test.global-gate", options: {},
    worker: { pollingIntervalSeconds: 0.5, groupConcurrency: 1 },
    admission: () => ({ canStart: () => true, stop() {} }), async run() {
      active++; peak = Math.max(peak, active);
      try { await delay(200); executions++; return { saved: true }; } finally { active--; }
    } });
  installModules([{ name: "studio", queues: [queue] }]);
  const ids = [await enqueueOn(queue, {}, { group: { id: "one-host" } }), await enqueueOn(queue, {}, { group: { id: "one-host" } })];
  const boss = await getBoss(), other = new PgBoss({ connectionString: config.databaseUrl, max: 2, schema: "pgboss" });
  other.on("error", () => {});
  await other.start();
  const first = await workModuleQueues(boss), second = await workModuleQueues(other);
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await boss.findJobs(queue.name)).filter(job => job.state === "completed").length !== 2) await delay(50);
    assert.equal(executions, 2);
    assert.equal(peak, 1);
    for (const id of ids) assert.equal((await boss.findJobs(queue.name, { id: id! }))[0]!.state, "completed");
  } finally { await Promise.all([first(), second()]); await other.stop({ graceful: true, timeout: 1000 }); }
});

test("需要心跳续租的队列不能进入尚未支持心跳的受控领取循环", async () => {
  let opened = false;
  const queue = defineQueue({ name: "studio.test.heartbeat-gate", options: { heartbeatSeconds: 10 }, worker: {},
    admission: () => { opened = true; return { canStart: () => false, stop() {} }; }, async run() {} });
  installModules([{ name: "studio", queues: [queue] }]);
  await assert.rejects(workModuleQueues(await getBoss()), /受控队列.*选项/);
  assert.equal(opened, false);
});

test("资源不足时持久任务保持待领取且不消耗重试，恢复后同一任务才运行", async () => {
  let now = 0, free = 1024 ** 3, executions = 0;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => ({ availableMemoryBytes: free, totalMemoryBytes: 8 * 1024 ** 3, cpus: [{ idle: now, total: now * 2 }] }) });
  const queue = defineQueue<{ value: number }>({ name: "studio.test.resource-gate", options: { retryLimit: 0 },
    worker: { pollingIntervalSeconds: 0.5, localConcurrency: 1, batchSize: 1 },
    admission: () => ({ canStart: () => monitor.status().state === "ready", stop: monitor.start() }),
    async run(data) { executions++; return { value: data[0]!.value }; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const id = await enqueueOn(queue, { value: 42 });
  const boss = await getBoss();
  const stop = await workModuleQueues(boss);
  try {
    await delay(650);
    const [waiting] = await boss.findJobs(queue.name, { id: id! });
    assert.equal(executions, 0);
    assert.equal(waiting!.state, "created");
    assert.equal(waiting!.retryCount, 0);
    assert.equal(waiting!.startedOn, null);
    free = 4 * 1024 ** 3;
    for (let n = 0; n < 13; n++) { now += 5000; monitor.sample(); }
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await boss.findJobs(queue.name, { id: id! }))[0]?.state !== "completed") await delay(50);
    const [finished] = await boss.findJobs(queue.name, { id: id! });
    assert.equal(finished!.state, "completed");
    assert.deepEqual(finished!.output, { value: 42 });
    assert.equal(finished!.retryCount, 0);
    assert.equal(executions, 1);
  } finally { await stop?.(); }
});

test("实际任务异常仍按原pg-boss重试政策结算，资源等待不替代业务失败", async () => {
  let attempts = 0;
  const queue = defineQueue({ name: "studio.test.actual-failure", options: { retryLimit: 1 },
    worker: { pollingIntervalSeconds: 0.5 }, admission: () => ({ canStart: () => true, stop() {} }),
    async run() { if (++attempts === 1) throw new Error("actual-task-failure"); return { saved: true }; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const id = await enqueueOn(queue, {});
  const boss = await getBoss(), stop = await workModuleQueues(boss);
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await boss.findJobs(queue.name, { id: id! }))[0]!.state !== "completed") await delay(50);
    const [job] = await boss.findJobs(queue.name, { id: id! });
    assert.equal(job!.state, "completed");
    assert.equal(job!.retryCount, 1);
    assert.deepEqual(job!.output, { saved: true });
    assert.equal(attempts, 2);
  } finally { await stop(); }
});

test("停止受控worker等待正在执行的安全写入，后续任务保持待领取且监测最后关闭", async () => {
  let release!: () => void, entered!: () => void, executions = 0, monitorClosed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const queue = defineQueue<{ value: number }>({ name: "studio.test.drain-gate", options: {}, worker: { pollingIntervalSeconds: 0.5 },
    admission: () => ({ canStart: () => true, stop() { monitorClosed = true; } }),
    async run(data) { executions++; entered(); await held; return { saved: data[0]!.value }; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const first = await enqueueOn(queue, { value: 1 }), second = await enqueueOn(queue, { value: 2 });
  const boss = await getBoss(), stop = await workModuleQueues(boss);
  try {
    await Promise.race([started, delay(2000).then(() => { throw new Error("task did not start"); })]);
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await delay(50);
    assert.equal(stopped, false);
    assert.equal(monitorClosed, false);
    release(); await stopping;
    assert.equal(monitorClosed, true);
    assert.equal(executions, 1);
    assert.equal((await boss.findJobs(queue.name, { id: first! }))[0]!.state, "completed");
    assert.equal((await boss.findJobs(queue.name, { id: second! }))[0]!.state, "created");
  } finally { release(); await stop(); }
});

test("后续队列配置失败时清理本次已启动的监测，不留下半套worker", async () => {
  let closed = false;
  const first = defineQueue({ name: "studio.test.partial-worker", options: {}, worker: {},
    admission: () => ({ canStart: () => false, stop() { closed = true; } }), async run() {} });
  const invalid = defineQueue({ name: "studio.test.partial-invalid", options: {}, worker: { batchSize: 2 },
    admission: () => ({ canStart: () => false, stop() {} }), async run() {} });
  installModules([{ name: "studio", queues: [first, invalid] }]);
  await assert.rejects(workModuleQueues(await getBoss()), /受控队列/);
  assert.equal(closed, true);
});

test("受控队列不能静默忽略并发、批次或其他不支持的worker选项", async () => {
  const boss = await getBoss();
  for (const worker of [{ localConcurrency: 2 }, { batchSize: 2 }, { heartbeatRefreshSeconds: 5 }, { transactional: true }]) {
    let opened = false;
    const queue = defineQueue({ name: "studio.test.unsupported-gate", options: {}, worker,
      admission: () => { opened = true; return { canStart: () => true, stop() {} }; }, async run() {} });
    installModules([{ name: "studio", queues: [queue] }]);
    await assert.rejects(workModuleQueues(boss), /受控队列.*单任务.*选项/);
    assert.equal(opened, false, "不支持的配置不能启动后台监测或领取循环");
  }
});

test("领取期间主机进入低内存时回滚领取，不启动任务也不记失败", async () => {
  let now = 0, free = 4 * 1024 ** 3, executions = 0, scheduledPressure = false;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => ({ availableMemoryBytes: free, totalMemoryBytes: 8 * 1024 ** 3, cpus: [{ idle: now, total: now * 2 }] }) });
  const stopMonitor = monitor.start();
  for (let n = 0; n < 13; n++) { now += 5000; monitor.sample(); }
  const queue = defineQueue<{ value: number }>({ name: "studio.test.pressure-during-claim", options: { retryLimit: 0 },
    worker: { pollingIntervalSeconds: 0.5, localConcurrency: 1, batchSize: 1 },
    admission: () => ({ canStart: () => {
      const ready = monitor.status().state === "ready";
      if (ready && !scheduledPressure) {
        scheduledPressure = true;
        queueMicrotask(() => { free = 1024 ** 3; now += 5000; monitor.sample(); });
      }
      return ready;
    }, stop: stopMonitor }),
    async run() { executions++; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const id = await enqueueOn(queue, { value: 1 });
  const boss = await getBoss(), stop = await workModuleQueues(boss);
  try {
    await delay(650);
    assert.equal(executions, 0);
    const [job] = await boss.findJobs(queue.name, { id: id! });
    assert.equal(job!.state, "created");
    assert.equal(job!.startedOn, null);
    assert.equal(job!.retryCount, 0);
  } finally { await stop(); }
});
