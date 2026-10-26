import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });

test("数据库驱动关池等待也受共享停止期限约束，重试确认同一次关池", async t => {
  const boss = await getBoss();
  // Isolate the final-close phase through pg-boss's public close:false lifecycle.
  await boss.stop({ close: false, graceful: true });
  const release = Promise.withResolvers<void>();
  const original = pg.Pool.prototype.end;
  let closes = 0;
  // PostgreSQL's external driver is the fault seam; keep the real DB and public queue lifecycle.
  t.mock.method(pg.Pool.prototype, "end", async function(this: pg.Pool) {
    closes++; await release.promise;
    await new Promise<void>(resolve => original.call(this, resolve));
  });
  let stopping: Promise<void> | undefined;
  try {
    stopping = stopBoss({ timeoutMs: 50 });
    const result = await Promise.race([stopping.then(() => "stopped", error => String(error.message)), delay(300).then(() => "still-waiting")]);
    assert.match(result, /未能确认.*退出/);
    assert.equal(closes, 1);
    await assert.rejects(stopBoss({ timeoutMs: 50 }), /未能确认.*退出/);
    assert.equal(closes, 1, "重试必须等待原关池，不能宣称成功或再开一套连接");
    release.resolve(); await stopBoss();
    assert.equal(closes, 1);
  } finally { release.resolve(); await stopping?.catch(() => {}); await stopBoss(); }
});
