import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { setTimeout as delay } from "node:timers/promises";
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";

after(closeDb);
const GiB = 1024 ** 3;

test("8GB提醒、6GB停新重任务、4.7GB保护，压力后恢复6GB放行且重启不绕过", async () => {
  let free = 20 * GiB;
  const disk = createDiskResourceMonitor({ availableBytes: async () => free });
  assert.equal(disk.status().ingestionAllowed, false);
  await disk.sample();
  assert.equal(disk.status().state, "normal");
  assert.equal(disk.status().heavyTaskAllowed, true);
  free = 7 * GiB; await disk.sample();
  assert.equal(disk.status().state, "warning");
  assert.equal(disk.status().ingestionAllowed, true);
  free = 5 * GiB; await disk.sample();
  assert.equal(disk.status().state, "limited");
  assert.equal(disk.status().heavyTaskAllowed, false);
  assert.equal(disk.status().ingestionAllowed, true);
  free = 5.5 * GiB; await disk.sample();
  assert.equal(disk.status().state, "limited");
  assert.equal(disk.status().heavyTaskAllowed, false);
  free = 4_700_000_000; await disk.sample();
  assert.equal(disk.status().ingestionAllowed, true, "4.7GB底线之上不额外封存12GiB");
  assert.equal(disk.status().heavyTaskAllowed, false);
  free = 4_699_999_999; await disk.sample();
  assert.equal(disk.status().state, "protected");
  assert.equal(disk.status().ingestionAllowed, false);
  free = 5.5 * GiB; await disk.sample();
  assert.equal(disk.status().ingestionAllowed, false);
  free = 6_000_000_000; await disk.sample();
  assert.equal(disk.status().ingestionAllowed, true);
  assert.equal(disk.status().heavyTaskAllowed, true);
  free = 5.5 * GiB;
  const restarted = createDiskResourceMonitor({ availableBytes: async () => free });
  await restarted.sample();
  assert.equal(restarted.status().ingestionAllowed, false, "重启不能抹掉需要恢复的压力状态");
});

test("不同监测实例都扣除真实共享预留，清理归还后按恢复线重开", async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 64 * GiB });
  const lease = await manager.reserve({ task: "disk-pressure-shared", category: "media", bytes: GiB });
  let free = 20 * GiB;
  const disk = createDiskResourceMonitor({ availableBytes: async () => free });
  try {
    await disk.sample();
    free = 4.5 * GiB; await disk.sample();
    assert.equal(disk.status().availableBytes, 4831838208);
    assert.equal(disk.status().reservedBytes, 1073741824);
    assert.equal(disk.status().unreservedBytes, 3758096384);
    assert.equal(disk.status().state, "protected");
    const second = createDiskResourceMonitor({ availableBytes: async () => free });
    await second.sample();
    assert.equal(second.status().ingestionAllowed, false);
  } finally { await manager.cleanup(lease.id); }
  free = 6 * GiB; await disk.sample();
  assert.equal(disk.status().reservedBytes, 0);
  assert.equal(disk.status().ingestionAllowed, true);
});

test("后台磁盘采样不重叠，停止后迟到结果不能复活，重新启动恢复实际采样", { timeout: 12_000 }, async () => {
  let reads = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const disk = createDiskResourceMonitor({ availableBytes: async () => {
    reads++; entered(); await waiting; return 20 * GiB;
  } });
  const stop = disk.start();
  await reading;
  const concurrent = disk.sample();
  stop(); release();
  await concurrent;
  assert.equal(reads, 1, "同一时刻只保留一个实际磁盘/预留查询");
  assert.equal(disk.status().state, "unavailable");
  assert.equal(disk.status().ingestionAllowed, false);
  const stopAgain = disk.start();
  try {
    await disk.sample();
    assert.equal(disk.status().state, "normal");
    await delay(5200);
    assert.ok(reads >= 3, "无需网页访问也会刷新后台样本");
  } finally { stopAgain(); }
  assert.equal(disk.status().heavyTaskAllowed, false);
});

test("磁盘监测异常、过期和慢返回不得延续放行，恢复仍需6GB且不泄露故障细节", async () => {
  let now = 0, free = 20 * GiB, failed = false, slow = false;
  const disk = createDiskResourceMonitor({ now: () => now, availableBytes: async () => {
    if (failed) throw new Error("private-disk-path-or-token");
    if (slow) now += 16_000;
    return free;
  } });
  await disk.sample();
  failed = true;
  await assert.doesNotReject(() => disk.sample());
  assert.equal(disk.status().state, "unavailable");
  assert.equal(disk.status().ingestionAllowed, false);
  assert.ok(!JSON.stringify(disk.status()).includes("private-disk"));
  failed = false; free = 5.5 * GiB; await disk.sample();
  assert.equal(disk.status().ingestionAllowed, false);
  free = 20 * GiB; await disk.sample();
  now = 15_001;
  assert.equal(disk.status().ingestionAllowed, false);
  assert.equal(disk.status().availableBytes, null);
  free = 5.5 * GiB; await disk.sample();
  assert.equal(disk.status().ingestionAllowed, false, "不能把过期前的正常状态带入新样本");
  slow = true; free = 20 * GiB;
  await disk.sample();
  assert.equal(disk.status().state, "unavailable", "慢查询返回时样本已经过期");
  slow = false;
  for (const invalid of [NaN, Infinity, -1, 1.2]) {
    free = invalid; await disk.sample();
    assert.equal(disk.status().state, "unavailable");
    assert.equal(disk.status().heavyTaskAllowed, false);
  }
});
