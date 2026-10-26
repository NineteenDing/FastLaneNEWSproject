import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import fs, { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { getBoss, recordRun, stopBoss } from "@aihot/backend/jobs/queue";
import { studio } from "../server.ts";
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { runsOverview } from "@aihot/backend/admin/runs";
import { setTimeout as delay } from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);

afterEach(async () => {
  installModules([]);
  const root = path.resolve(config.dataDir);
  assert.match(path.basename(path.dirname(root)), /^aihot-test-\d+-/);
  const owned = path.resolve(root, "imgcache");
  assert.ok(owned.startsWith(root + path.sep));
  await rm(owned, { recursive: true, force: true });
});
after(async () => { setGlobalDispatcher(previous); await transport.close(); await stopBoss(); await closeDb(); });

test("后台压力检查回收过期缓存，不等凌晨且不因读取磁盘状态而删除文件", async () => {
  installModules([studio]);
  const root = path.join(config.dataDir, "imgcache");
  await mkdir(root, { recursive: true });
  const expired = path.join(root, "expired-pressure-fixture"), fresh = path.join(root, "fresh-pressure-fixture");
  await writeFile(expired, "expired-cache"); await writeFile(fresh, "new-cache");
  const old = new Date(Date.now() - 40 * 86400_000);
  await utimes(expired, old, old);
  const space = mock.method(fs, "statfs", async () => ({ bavail: 7_000_000_000n, bsize: 1n }));
  syncBuiltinESMExports();
  try {
    const disk = createDiskResourceMonitor();
    await disk.sample();
    assert.equal(disk.status().state, "warning");
    assert.equal(await readFile(expired, "utf8"), "expired-cache", "读取/采样不执行清理");
    const schedule = studio.schedules?.find(item => item.name === "studio.storage.pressure");
    assert.ok(schedule, "无需开启采集也提供后台磁盘压力检查");
    assert.equal(schedule.cron, "* * * * *");
    assert.equal(schedule.when?.() ?? true, true);
    const result = await schedule.run() as { prunedCache: number; disk: { state: string } };
    assert.equal(result.prunedCache, 1);
    assert.equal(result.disk.state, "warning", "未实际恢复空间时不宣称恢复正常");
    await assert.rejects(readFile(expired), { code: "ENOENT" });
    assert.equal(await readFile(fresh, "utf8"), "new-cache");
  } finally { space.mock.restore(); syncBuiltinESMExports(); }
});

test("压力检查正常时不清理，未知时报告安全失败，并按真实共享预留判断是否需回收", async () => {
  installModules([studio]);
  await getBoss();
  const root = path.join(config.dataDir, "imgcache");
  await mkdir(root, { recursive: true });
  const file = path.join(root, "reserved-pressure-fixture");
  await writeFile(file, "reserved-cache");
  const old = new Date(Date.now() - 40 * 86400_000);
  await utimes(file, old, old);
  let unknown = false;
  const space = mock.method(fs, "statfs", async () => {
    if (unknown) throw new Error("private-statfs-path-fixture");
    return { bavail: 8_000_000_000n, bsize: 1n };
  });
  syncBuiltinESMExports();
  const manager = createStorageWorkspaces({ availableBytes: async () => 64 * 1024 ** 3 });
  let workspace: Awaited<ReturnType<typeof manager.reserve>> | undefined;
  try {
    const schedule = studio.schedules!.find(item => item.name === "studio.storage.pressure")!;
    assert.equal((await schedule.run() as { prunedCache: number }).prunedCache, 0);
    assert.equal(await readFile(file, "utf8"), "reserved-cache");
    unknown = true;
    await assert.rejects(recordRun(schedule.name, schedule.run), /磁盘状态无法确认/);
    const failed = (await runsOverview()).timeline.find(run => run.job === schedule.name);
    assert.equal(failed?.status, "failed");
    assert.ok(!failed?.error?.includes("private-statfs"));
    assert.equal(await readFile(file, "utf8"), "reserved-cache");
    unknown = false;
    workspace = await manager.reserve({ task: "pressure-reserved-space", category: "media", bytes: 1024 ** 3 });
    const result = await schedule.run() as { prunedCache: number; disk: { state: string; reservedBytes: number } };
    assert.equal(result.prunedCache, 1);
    assert.equal(result.disk.state, "warning");
    assert.equal(result.disk.reservedBytes, 1073741824);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    if (workspace) await manager.cleanup(workspace.id);
    space.mock.restore(); syncBuiltinESMExports();
  }
});

test("采集关闭时仍注册持久压力任务，拒删失败记录可查，原任务重试后才确认完成", { timeout: 45_000 }, async () => {
  const enabled = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "false";
  installModules([studio]);
  const root = path.join(config.dataDir, "imgcache");
  await mkdir(root, { recursive: true });
  const file = path.join(root, "queue-pressure-fixture");
  await writeFile(file, "locked-cache");
  const old = new Date(Date.now() - 40 * 86400_000);
  await utimes(file, old, old);
  let denied = true;
  const unlink = fs.unlink;
  const refusal = mock.method(fs, "unlink", async (target: Parameters<typeof unlink>[0]) => {
    if (target === file && denied) throw Object.assign(new Error("private-unlink-path-fixture"), { code: "EACCES" });
    return unlink(target);
  });
  const space = mock.method(fs, "statfs", async () => ({ bavail: 5_000_000_000n, bsize: 1n }));
  syncBuiltinESMExports();
  try {
    const { registerSchedules } = await import("../../../apps/worker/src/schedules.ts");
    const boss = await getBoss();
    await registerSchedules(boss);
    const queue = "cron.studio.storage.pressure";
    assert.ok((await boss.getSchedules()).some(schedule => schedule.name === queue));
    const id = await boss.send(queue, {});
    assert.ok(id);
    const waitUntil = async (ready: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) { if (await ready()) return; await delay(50); }
      assert.fail("持久压力任务未在截止前达到预期状态");
    };
    await waitUntil(async () => (await boss.findJobs(queue, { id }))[0]?.state === "retry");
    assert.equal(await readFile(file, "utf8"), "locked-cache");
    const failed = (await runsOverview()).timeline.find(run => run.job === "studio.storage.pressure");
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /图片缓存清理失败/);
    assert.ok(!failed?.error?.includes("private-unlink"));
    denied = false;
    await waitUntil(async () => (await boss.findJobs(queue, { id }))[0]?.state === "completed");
    const completed = (await boss.findJobs(queue, { id }))[0]!;
    assert.equal(completed.retryCount, 1);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal((await runsOverview()).timeline.find(run => run.job === "studio.storage.pressure")?.status, "ok");
  } finally {
    await stopBoss();
    refusal.mock.restore(); space.mock.restore(); syncBuiltinESMExports();
    if (enabled === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = enabled;
  }
});
