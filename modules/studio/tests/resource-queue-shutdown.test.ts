import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { defineQueue, installModules } from "@aihot/backend/modules";
import { enqueueOn, getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });

test("整体停止同时禁止普通队列和受控队列领取，保留在途任务的真实完成结果", async () => {
  let release!: () => void, entered!: () => void, ordinaryExecutions = 0, monitorClosed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const queue = defineQueue({ name: "studio.test.stop-admitted", options: {}, worker: {},
    admission: () => ({ canStart: () => true, stop() { monitorClosed = true; } }),
    async run() { entered(); await held; return { saved: true }; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const id = await enqueueOn(queue, {});
  const boss = await getBoss(), stop = await workModuleQueues(boss);
  const ordinary = "studio.test.stop-ordinary";
  await boss.createQueue(ordinary);
  await boss.work(ordinary, { pollingIntervalSeconds: 0.5 }, async () => { ordinaryExecutions++; });
  const observer = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss", max: 2 });
  observer.on("error", () => {}); await observer.start();
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([started, delay(2000).then(() => { throw new Error("task did not start"); })]);
    stopping = stopBoss();
    await delay(100);
    const pending = await observer.send(ordinary, {});
    await delay(650);
    assert.equal(ordinaryExecutions, 0, "受控工作保存期间，普通worker也必须已停止领取");
    assert.equal(monitorClosed, false);
    release(); await stopping;
    assert.equal(monitorClosed, true);
    assert.equal((await observer.findJobs(queue.name, { id: id! }))[0]!.state, "completed");
    assert.deepEqual((await observer.findJobs(queue.name, { id: id! }))[0]!.output, { saved: true });
    assert.equal((await observer.findJobs(ordinary, { id: pending! }))[0]!.state, "created");
  } finally {
    release(); await stopping; await stop(); await observer.stop({ graceful: true, timeout: 1000 });
  }
});
