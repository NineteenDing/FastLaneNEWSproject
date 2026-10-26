import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { weiboFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
process.env.STUDIO_MEDIA_ENABLED = "true";
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

for (const pool of [4, 1]) test(`独立媒体worker业务池${pool}连接，实际PG会话中断仍保住执行位，其他采集保持排队且完成后能继续`, { timeout: 30_000 }, async () => {
  await resources.warm();
  const creator = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } })).json().creator;
  const text = `实际独立进程连接故障${pool}`;
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} });
  weiboFixture(transport, { complete: true, video: true, text });
  const boss = await getBoss(), [collected] = await boss.fetch(creatorQueue.name); assert.ok(collected);
  await creatorQueue.run([collected.data] as never[]); await boss.complete(creatorQueue.name, collected.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows[0];
  const child = spawn(process.execPath, ["modules/studio/tests/media-queue-child.ts"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, DATABASE_POOL_MAX: String(pool) } });
  const exited = once(child, "exit");
  const entered = new Promise<number>((resolve, reject) => {
    child.on("message", message => { if (message && typeof message === "object" && "type" in message && message.type === "recognizing" && "databasePid" in message) resolve(Number(message.databasePid)); });
    child.once("exit", () => reject(new Error("independent worker exited before recognition")));
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const databasePid = await Promise.race([entered, delay(7000).then(() => { throw new Error("独立消费者未开始：小连接池可能被执行位自身占满"); })]);
    await sql`SELECT pg_terminate_backend(${databasePid}::int)`;
    installModules([{ ...studio, name: "other-media-group-member", queues: [{ ...creatorQueue, admission: resources.admission }] }]);
    let reads = 0; weiboFixture(transport, { complete: true, video: true, text, onRead: () => { reads++; } });
    await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} });
    stop = await workModuleQueues(boss); await resources.warm(); await delay(2300);
    const waiting = await boss.findJobs(creatorQueue.name, { queued: true }); assert.equal(waiting.length, 1, "持有执行位的数据库会话消失后，仍不能提前领取另一个重任务");
    assert.equal(waiting[0]!.retryCount, 0); assert.equal(reads, 0);
    if (pool === 4) {
      await sql.unsafe("CREATE SEQUENCE queue_release_fault_attempts");
      await sql.unsafe("CREATE FUNCTION queue_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('queue_release_fault_attempts'); RAISE EXCEPTION 'controlled execution slot release failure'; END $$");
      await sql.unsafe("CREATE TRIGGER queue_release_failure BEFORE DELETE ON module_queue_execution_leases FOR EACH ROW EXECUTE FUNCTION queue_release_failure()");
    }
    let deadline = Date.now() + 7000;
    try {
      child.send("release");
      while (Date.now() < deadline && (await app.inject({ url: `/api/admin/studio/media-processing/${post.id}`, headers })).json().state !== "ready") await delay(50);
      assert.equal((await app.inject({ url: `/api/admin/studio/media-processing/${post.id}`, headers })).json().state, "ready");
      if (pool === 4) {
        while (Date.now() < deadline && !(await sql`SELECT is_called FROM queue_release_fault_attempts`)[0]!.is_called) await delay(50);
        assert.equal((await sql`SELECT is_called FROM queue_release_fault_attempts`)[0]!.is_called, true);
        assert.equal(child.exitCode, null, "释放执行位失败不能让消费者崩溃退出");
        assert.equal((await boss.findJobs(creatorQueue.name, { queued: true })).length, 1, "释放尚未成功时不能假装已归还执行位");
      }
    } finally {
      if (pool === 4) {
        await sql.unsafe("DROP TRIGGER queue_release_failure ON module_queue_execution_leases");
        await sql.unsafe("DROP FUNCTION queue_release_failure()"); await sql.unsafe("DROP SEQUENCE queue_release_fault_attempts");
      }
    }
    deadline = Date.now() + 7000;
    while (Date.now() < deadline && Number(reads) !== 1) await delay(50);
    assert.equal(reads, 1); await stop(); stop = undefined;
    child.send("stop"); assert.equal((await exited)[0], 0);
    transport.assertNoPendingInterceptors();
  } finally {
    if (child.connected) child.send("stop");
    await stop?.();
    await Promise.race([exited, delay(3000).then(() => { if (child.exitCode === null) child.kill(); })]);
  }
});
