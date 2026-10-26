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

test("重任务无法在停止期限内退出时明确报未确认，保留连接和任务直到实际保存完成", async () => {
  const held = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let monitorClosed = false;
  const queue = defineQueue({ name: "studio.test.stop-deadline", options: {}, worker: {},
    admission: () => ({ canStart: () => true, stop() { monitorClosed = true; } }),
    async run() { started.resolve(); await held.promise; return { saved: true }; } });
  installModules([{ name: "studio", queues: [queue] }]);
  const id = await enqueueOn(queue, {});
  const boss = await getBoss(), stop = await workModuleQueues(boss);
  const observer = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss", max: 2 });
  observer.on("error", () => {}); await observer.start();
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([started.promise, delay(2000).then(() => { throw new Error("task did not start"); })]);
    stopping = stopBoss({ timeoutMs: 50 });
    const result = await Promise.race([stopping.then(() => "stopped", error => String(error.message)), delay(300).then(() => "still-waiting")]);
    assert.match(result, /未能确认.*退出/);
    assert.equal(monitorClosed, false);
    assert.equal((await observer.findJobs(queue.name, { id: id! }))[0]!.state, "active");
    held.resolve(); await stop(); await stopBoss();
    const [finished] = await observer.findJobs(queue.name, { id: id! });
    assert.equal(finished!.state, "completed");
    assert.deepEqual(finished!.output, { saved: true });
    assert.equal(monitorClosed, true);
  } finally {
    held.resolve(); await stopping?.catch(() => {}); await stop();
    await observer.stop({ graceful: true, timeout: 1000 });
  }
});
