import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(closeDb);
test("新批次冻结遵守现有主机和磁盘/数据库准入，压力下旧批次仍能幂等读取，恢复后再冻结", async t => {
  const resources = await sourceResourceFixture(), { app, headers, capacity } = resources;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T12:00:00Z") });
  const freeze = (startsAt: string) => app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } });
  try {
    await resources.warm();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
      payload: { version: 0, enabled: false, startsAt: "2026-10-20T12:00:00Z" } })).statusCode, 200);
    const original = await freeze("2026-10-20T12:00:00.000Z"); assert.equal(original.statusCode, 200);
    const batch = original.json().batch;
    for (const diskBytes of [4_699_999_999, 5_000_000_000, NaN]) {
      capacity.diskBytes = diskBytes; await resources.api.disk.sample();
      const waiting = await freeze("2026-10-22T12:00:00.000Z");
      assert.equal(waiting.statusCode, 503); assert.equal(waiting.headers["retry-after"], "60"); assert.equal(waiting.headers["cache-control"], "no-store");
      assert.deepEqual((await freeze("2026-10-20T12:00:00.000Z")).json().batch, batch);
      assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 1);
    }
    capacity.diskBytes = 20 * 1024 ** 3; capacity.databaseBytes = 7 * 1024 ** 3; await resources.warm();
    assert.equal((await freeze("2026-10-22T12:00:00.000Z")).statusCode, 503);
    capacity.databaseBytes = 1024 ** 3; capacity.memoryBytes = 1024 ** 3; await resources.warm();
    assert.equal((await freeze("2026-10-22T12:00:00.000Z")).statusCode, 503);
    capacity.memoryBytes = 4 * 1024 ** 3; await resources.warm();
    assert.equal((await freeze("2026-10-22T12:00:00.000Z")).statusCode, 200);
  } finally { await app.close(); }
});
