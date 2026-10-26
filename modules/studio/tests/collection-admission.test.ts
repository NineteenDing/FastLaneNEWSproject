import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createDatabaseResourceMonitor } from "../backend/database-resources.ts";
import { createCollectionAdmission } from "../backend/collection-admission.ts";

after(closeDb);

test("新闻准入同时遵守采集开关、主机与容量判断，已关闭的所属准入不能复活", async () => {
  let now = 0, free = 20 * 1024 ** 3, usage = 1024 ** 3;
  const host = createHostResourceMonitor({ now: () => now, read: () => {
    now += 5000; return { availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3,
      cpus: [{ idle: now, total: now * 2 }] };
  } });
  const disk = createDiskResourceMonitor({ availableBytes: async () => free });
  const database = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes: usage, walBytes: 0, temporaryBytes: 0 }) });
  const before = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "true";
  const open = createCollectionAdmission({ host, disk, database }), gate = open();
  try {
    assert.equal(gate.canStart(), false);
    for (let n = 0; n < 14; n++) host.sample();
    await disk.sample(); await database.sample();
    assert.equal(gate.canStart(), true);
    usage = 6 * 1024 ** 3; await database.sample();
    assert.equal(gate.canStart(), false);
    usage = 1024 ** 3; await database.sample();
    free = 4_699_999_999; await disk.sample();
    assert.equal(gate.canStart(), false);
    free = 20 * 1024 ** 3; await disk.sample();
    process.env.COLLECT_ENABLED = "false";
    assert.equal(gate.canStart(), false);
    process.env.COLLECT_ENABLED = "true";
    assert.equal(gate.canStart(), true);
    gate.stop();
    for (let n = 0; n < 14; n++) host.sample();
    await disk.sample(); await database.sample();
    assert.equal(gate.canStart(), false);
  } finally {
    gate.stop();
    if (before === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = before;
  }
});

test("同一组新闻监测只属于一个活动消费者，关闭后才可重新接管", () => {
  const open = createCollectionAdmission();
  const first = open();
  let second: ReturnType<typeof open> | undefined;
  try {
    assert.throws(() => { second = open(); }, /已.*使用|占用/);
    first.stop();
    second = open();
    assert.equal(second.canStart(), false);
  } finally { second?.stop(); first.stop(); }
});
