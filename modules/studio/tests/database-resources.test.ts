import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createDatabaseResourceMonitor } from "../backend/database-resources.ts";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

after(closeDb);
const GiB = 1024 ** 3;

test("数据库含共享WAL和当前临时量达6GiB暂停入库，恢复5.5GiB后重开，重启不绕过", async () => {
  let databaseBytes = 3 * GiB;
  const monitor = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes, walBytes: GiB, temporaryBytes: GiB }) });
  assert.equal(monitor.status().ingestionAllowed, false);
  await monitor.sample();
  assert.equal(monitor.status().state, "warning");
  assert.equal(monitor.status().usedBytes, 5368709120);
  assert.equal(monitor.status().ingestionAllowed, true);
  databaseBytes = 4 * GiB; await monitor.sample();
  assert.equal(monitor.status().state, "limited");
  assert.equal(monitor.status().ingestionAllowed, false);
  databaseBytes = 3.75 * GiB; await monitor.sample();
  assert.equal(monitor.status().state, "recovering");
  assert.equal(monitor.status().ingestionAllowed, false);
  const restarted = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes, walBytes: GiB, temporaryBytes: GiB }) });
  await restarted.sample();
  assert.equal(restarted.status().ingestionAllowed, false);
  databaseBytes = 3.5 * GiB; await monitor.sample();
  assert.equal(monitor.status().ingestionAllowed, true);
  databaseBytes = GiB; await monitor.sample();
  assert.equal(monitor.status().state, "normal");
});

test("默认监测读取真实PG分项，表与索引增长会进入本应用容量，不把WAL算成零", async () => {
  const monitor = createDatabaseResourceMonitor();
  await monitor.sample();
  const before = monitor.status();
  assert.ok(before.databaseBytes! > 0);
  assert.ok(before.walBytes! >= 16 * 1024 ** 2);
  assert.ok(before.temporaryBytes! >= 0);
  try {
    await sql`CREATE TABLE studio_capacity_probe AS SELECT n, md5(n::text) payload FROM generate_series(1,65536) n`;
    await sql`CREATE INDEX studio_capacity_probe_payload_idx ON studio_capacity_probe(payload)`;
    await monitor.sample();
    const after = monitor.status();
    assert.ok(after.databaseBytes! - before.databaseBytes! > 1024 ** 2);
    assert.equal(after.scope, "database_with_shared_wal_temp");
    assert.equal(after.limitBytes, 6442450944);
  } finally { await sql`DROP TABLE IF EXISTS studio_capacity_probe`; }
});

test("真实PG排序临时文件仅在当前仍占盘时计入，关闭游标后不延用累计临时字节", async () => {
  const monitor = createDatabaseResourceMonitor();
  await monitor.sample();
  const baseline = monitor.status().temporaryBytes!;
  await sql.begin(async tx => {
    await tx`SET LOCAL work_mem = '64kB'`;
    await tx`DECLARE capacity_cursor CURSOR FOR SELECT n, md5(n::text) payload FROM generate_series(1,65536) n ORDER BY payload`;
    await tx`FETCH 1 FROM capacity_cursor`;
    await monitor.sample();
    assert.ok(monitor.status().temporaryBytes! - baseline > 1024 ** 2);
    await tx`CLOSE capacity_cursor`;
  });
  await monitor.sample();
  assert.equal(monitor.status().temporaryBytes, baseline);
});

test("真实PG并行哈希的fileset子目录也计入当前临时容量", { timeout: 15_000 }, async () => {
  await sql`CREATE UNLOGGED TABLE studio_parallel_capacity WITH (parallel_workers=2) AS
    SELECT n, md5(n::text) payload FROM generate_series(1,100000) n`;
  await sql`ANALYZE studio_parallel_capacity`;
  let running: Promise<unknown> | undefined;
  try {
    running = sql.begin(async tx => {
      await tx`SET LOCAL work_mem = '64kB'`;
      await tx`SET LOCAL min_parallel_table_scan_size = 0`;
      await tx`SET LOCAL parallel_setup_cost = 0`;
      await tx`SET LOCAL parallel_tuple_cost = 0`;
      await tx`SET LOCAL max_parallel_workers_per_gather = 2`;
      await tx`SET LOCAL enable_mergejoin = off`;
      await tx`SET LOCAL enable_nestloop = off`;
      const plan = await tx`EXPLAIN (FORMAT JSON) SELECT pg_sleep(3),sum(a.n) FROM studio_parallel_capacity a JOIN studio_parallel_capacity b ON a.payload=b.payload`;
      assert.match(JSON.stringify(plan), /"Parallel Aware":true/);
      await tx`SELECT pg_sleep(3),sum(a.n) FROM studio_parallel_capacity a JOIN studio_parallel_capacity b ON a.payload=b.payload`;
    });
    let sharedBytes = 0;
    const deadline = Date.now() + 2500;
    while (sharedBytes <= 1024 ** 2 && Date.now() < deadline) {
      const [observed] = await sql<{ bytes: number }[]>`SELECT coalesce(sum((pg_stat_file('base/pgsql_tmp/'||d.name||'/'||f.name,true)).size),0)::bigint bytes
        FROM pg_ls_dir('base/pgsql_tmp',true,false) d(name)
        CROSS JOIN LATERAL pg_ls_dir('base/pgsql_tmp/'||d.name,true,false) f(name)
        WHERE d.name LIKE '%.fileset'`;
      sharedBytes = observed!.bytes;
      if (sharedBytes <= 1024 ** 2) await delay(10);
    }
    assert.ok(sharedBytes > 1024 ** 2, "必须实际产生fileset溢写，而非仅打开并行计划");
    const monitor = createDatabaseResourceMonitor();
    await monitor.sample();
    assert.ok(monitor.status().temporaryBytes! >= sharedBytes, "一级普通文件统计不能漏掉实际fileset字节");
  } finally {
    await running;
    await sql`DROP TABLE studio_parallel_capacity`;
  }
});

test("自有非默认表空间中的真实排序临时文件也计入，结束后释放并移除测试表空间", async () => {
  const directory = await mkdtemp(path.resolve(".local/database-capacity-space-"));
  const name = "studio_capacity_" + randomBytes(6).toString("hex");
  let created = false;
  try {
    await sql.unsafe(`CREATE TABLESPACE "${name}" LOCATION '${directory.replaceAll("\\", "/").replaceAll("'", "''")}'`);
    created = true;
    const monitor = createDatabaseResourceMonitor();
    await monitor.sample();
    const baseline = monitor.status().temporaryBytes!;
    await sql.begin(async tx => {
      await tx`SELECT set_config('temp_tablespaces',${name},true)`;
      await tx`SET LOCAL work_mem = '64kB'`;
      await tx`DECLARE capacity_space_cursor CURSOR FOR SELECT n, md5(n::text) payload FROM generate_series(1,65536) n ORDER BY payload`;
      await tx`FETCH 1 FROM capacity_space_cursor`;
      await monitor.sample();
      assert.ok(monitor.status().temporaryBytes! - baseline > 1024 ** 2);
      await tx`CLOSE capacity_space_cursor`;
    });
  } finally {
    if (created) await sql.unsafe(`DROP TABLESPACE "${name}"`);
    assert.ok(directory.startsWith(path.resolve(".local") + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test("容量读取异常、非法或过期时保守暂停，不泄露错误且恢复仍须低于恢复线", async () => {
  let now = 0, bytes = GiB, fail = false, slow = false;
  const monitor = createDatabaseResourceMonitor({ now: () => now, read: async () => {
    if (fail) throw new Error("private-pg-path-password");
    if (slow) now += 90_001;
    return { databaseBytes: bytes, walBytes: 1, temporaryBytes: 0 };
  } });
  await monitor.sample();
  assert.equal(monitor.status().ingestionAllowed, true);
  fail = true;
  await assert.doesNotReject(() => monitor.sample());
  assert.equal(monitor.status().state, "unavailable");
  assert.equal(monitor.status().usedBytes, null);
  assert.ok(!JSON.stringify(monitor.status()).includes("private-pg"));
  fail = false; bytes = 5.75 * GiB; await monitor.sample();
  assert.equal(monitor.status().ingestionAllowed, false);
  bytes = GiB; await monitor.sample();
  now += 90_001;
  assert.equal(monitor.status().ingestionAllowed, false);
  assert.equal(monitor.status().usedBytes, null);
  bytes = 5.75 * GiB; await monitor.sample();
  assert.equal(monitor.status().ingestionAllowed, false, "过期前的放行不能延续到恢复线以上的新样本");
  slow = true; bytes = GiB; await monitor.sample();
  assert.equal(monitor.status().state, "unavailable");
  slow = false;
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    bytes = invalid; await monitor.sample();
    assert.equal(monitor.status().ingestionAllowed, false);
  }
  now = -1; bytes = GiB; await monitor.sample();
  assert.equal(monitor.status().state, "unavailable");
});

test("剩余时间只按相邻有效增长样本估算，首样本或回落显示未知，过期不延用预测", async () => {
  let now = 0, databaseBytes = 4 * GiB;
  const monitor = createDatabaseResourceMonitor({ now: () => now,
    read: async () => ({ databaseBytes, walBytes: 0, temporaryBytes: 0 }) });
  await monitor.sample();
  assert.equal(monitor.status().estimatedRemainingSeconds, null);
  now = 60_000; databaseBytes = 5 * GiB; await monitor.sample();
  assert.equal(monitor.status().estimatedRemainingSeconds, 60);
  now = 90_000;
  assert.equal(monitor.status().estimatedRemainingSeconds, 30);
  databaseBytes = 4 * GiB; await monitor.sample();
  assert.equal(monitor.status().estimatedRemainingSeconds, null);
  now = 120_000; databaseBytes = 6 * GiB; await monitor.sample();
  assert.equal(monitor.status().estimatedRemainingSeconds, 0);
  now = 210_001;
  assert.equal(monitor.status().estimatedRemainingSeconds, null);
});

test("后台采样不重叠，停止后迟到结果不复活，重启与定时采样无需网页访问", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const monitor = createDatabaseResourceMonitor({ read: async () => {
    reads++; entered(); await waiting; return { databaseBytes: GiB, walBytes: 0, temporaryBytes: 0 };
  } });
  const stop = monitor.start();
  await reading;
  const concurrent = monitor.sample();
  stop(); release(); await concurrent;
  assert.equal(reads, 1);
  assert.equal(monitor.status().state, "unavailable");
  const stopAgain = monitor.start();
  try {
    await monitor.sample();
    assert.equal(monitor.status().state, "normal");
    t.mock.timers.tick(30_000); await monitor.sample();
    assert.equal(reads, 3);
  } finally { stopAgain(); }
  t.mock.timers.tick(30_000);
  assert.equal(reads, 3);
  assert.equal(monitor.status().ingestionAllowed, false);
});
