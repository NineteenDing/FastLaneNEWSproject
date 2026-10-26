import assert from "node:assert/strict";
import { test } from "node:test";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { windowsDeletePermissionScript } from "../../../tests/windows-delete-permission.ts";
import { createRuntimeLogs } from "../backend/runtime-logs.ts";

async function removeFixture(directory: string) {
  assert.ok(directory.startsWith(path.resolve(".local") + path.sep));
  await rm(directory, { recursive: true, force: true });
}
test("空闲跨日且磁盘不足时不创建压缩文件，轮转只随受保护的写入发生", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  syncBuiltinESMExports();
  const directory = await mkdtemp(path.resolve(".local/runtime-log-midnight-"));
  let free = 5_773_741_824;
  const logs = await createRuntimeLogs(directory, { availableBytes: async () => free });
  try {
    await logs.write("api", "before-midnight");
    free = 4_699_999_999;
    t.mock.timers.setTime(Date.now() + 86_400_000);
    t.mock.timers.tick(86_400_000);
    await logs.close();
    assert.equal((await readdir(directory)).filter(name => name.endsWith(".gz")).length, 0);
    assert.equal(await readFile(path.join(directory, "api.log"), "utf8"), "before-midnight\n");
  } finally {
    await logs.close();
    t.mock.timers.reset(); syncBuiltinESMExports();
    await removeFixture(directory);
  }
});

test("API和网页日志按字节轮转压缩，只保留有限归档并可读回最新日志", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-test-"));
  const logs = await createRuntimeLogs(directory, { fileBytes: 256, archiveFiles: 2 });
  try {
    for (let n = 0; n < 12; n++) await logs.write("api", `record-${n}:` + "文本".repeat(30));
    await logs.write("web", "web-latest");
  } finally { await logs.close(); }
  try {
    const files = await readdir(directory);
    assert.equal(files.filter(name => /^api\.log\.\d+\.gz$/.test(name)).length, 2);
    const latest = gunzipSync(await readFile(path.join(directory, "api.log.1.gz"))).toString();
    assert.match(latest, /record-11/);
    assert.equal(await readFile(path.join(directory, "web.log"), "utf8"), "web-latest\n");
  } finally {
    await removeFixture(directory);
  }
});

test("Windows拒绝轮转清理时记录不可用，关闭仍完成文件释放，不把日志错误带成退出悬挂", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-io-"));
  const logs = await createRuntimeLogs(directory, { fileBytes: 256 });
  const file = path.join(directory, "api.log"), script = path.join(directory, "permission.ps1");
  await writeFile(script, windowsDeletePermissionScript);
  const permission = (restore = false) => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-LockedFile", file, ...(restore ? ["-Restore"] : [])], { windowsHide: true, timeout: 5000 });
  try {
    assert.equal(await logs.write("api", "first-record"), true);
    await permission();
    assert.equal(await logs.write("api", "x".repeat(250)), false);
    assert.equal((await logs.status()).state, "unavailable");
    assert.equal(await logs.write("web", "healthy-web-output"), true);
    assert.equal((await logs.status()).state, "unavailable", "另一条正常日志不能掩盖已损坏的API日志流");
    await permission(true);
    const closed = await Promise.race([logs.close().then(() => "closed", () => "failed"), delay(1000).then(() => "waiting")]);
    assert.equal(closed, "closed");
  } finally {
    await permission(true); await logs.close().catch(() => {});
    await removeFixture(directory);
  }
});

test("没有新输出时后台仍清理过期归档，关闭后不再改动目录", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = await mkdtemp(path.resolve(".local/runtime-log-idle-"));
  const logs = await createRuntimeLogs(directory);
  const archived = path.join(directory, "web.log.1.gz");
  const old = new Date(Date.now() - 8 * 86_400_000);
  try {
    await writeFile(archived, "old"); await utimes(archived, old, old);
    t.mock.timers.tick(3_600_000);
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && await access(archived).then(() => true, () => false)) await delay(10);
    await assert.rejects(() => access(archived), { code: "ENOENT" });
    await logs.close();
    await writeFile(archived, "after-close"); await utimes(archived, old, old);
    t.mock.timers.tick(3_600_000); await delay(20);
    assert.equal(await readFile(archived, "utf8"), "after-close");
  } finally {
    await logs.close();
    await removeFixture(directory);
  }
});

test("启动时清理超过七天的自有归档，保留当前日志和其他文件", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-retention-"));
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (const name of ["api.log.1.gz", "api.log", "notes.txt"]) {
    await writeFile(path.join(directory, name), "old-content");
    await utimes(path.join(directory, name), old, old);
  }
  let logs: Awaited<ReturnType<typeof createRuntimeLogs>> | undefined;
  try {
    logs = await createRuntimeLogs(directory);
    await assert.rejects(() => access(path.join(directory, "api.log.1.gz")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(directory, "api.log"), "utf8"), "old-content");
    assert.equal(await readFile(path.join(directory, "notes.txt"), "utf8"), "old-content");
  } finally {
    await logs?.close();
    await removeFixture(directory);
  }
});

test("分块中文和密钥跨输入边界仍正确遮蔽，超长行只记省略提示，末行不丢失", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-redaction-"));
  const secret = "known-secret-across-chunks";
  const logs = await createRuntimeLogs(directory, { fileBytes: 256, secrets: [secret] });
  const input = Buffer.from(`你好 ${secret}\n${"x".repeat(2000)}\n末行 ${secret}`);
  async function* chunks() { for (let index = 0; index < input.length; index += 7) yield input.subarray(index, index + 7); }
  try {
    await logs.capture("api", chunks());
    assert.equal((await logs.status()).droppedRecords, 1);
  } finally { await logs.close(); }
  try {
    const saved = await readFile(path.join(directory, "api.log"), "utf8");
    assert.match(saved, /你好 \[REDACTED\]/);
    assert.match(saved, /末行 \[REDACTED\]/);
    assert.match(saved, /超长日志已省略/);
    assert.ok(!saved.includes(secret));
    assert.ok(!saved.includes("xxxxxxxx"));
  } finally {
    await removeFixture(directory);
  }
});

test("秘密遮蔽后膨胀超过单行额度时只保存省略提示", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-expanded-"));
  const logs = await createRuntimeLogs(directory, { secrets: ["abcd"] });
  try {
    await logs.write("api", "abcd".repeat(4000));
    await logs.close();
    const saved = await readFile(path.join(directory, "api.log"), "utf8");
    assert.ok(Buffer.byteLength(saved) <= 16_385);
    assert.equal(saved, "[超长日志已省略]\n");
    assert.equal((await logs.status()).droppedRecords, 1);
  } finally {
    await logs.close();
    await removeFixture(directory);
  }
});

test("低磁盘或已有日志超额时停止追加并报告丢弃，空间恢复后继续，不增加超额字节", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-budget-"));
  let free = 5_773_741_824;
  const logs = await createRuntimeLogs(directory, { fileBytes: 256, totalBytes: 8192, availableBytes: async () => free });
  try {
    assert.equal(await logs.write("api", "kept"), true);
    free = 4_699_999_999;
    assert.equal(await logs.write("web", "suppressed"), false);
    assert.equal((await logs.status()).state, "limited");
    assert.equal((await logs.status()).droppedRecords, 1);
    free = 5_773_741_824;
    assert.equal(await logs.write("web", "recovered"), true);
    assert.equal((await logs.status()).state, "normal");
    for (let index = 1; index <= 7; index++) await writeFile(path.join(directory, `api.log.${index}.gz`), Buffer.alloc(2048));
    const before = (await logs.status()).storedBytes;
    assert.equal(await logs.write("api", "over-budget"), false);
    assert.equal((await logs.status()).storedBytes, before);
    assert.equal((await logs.status()).droppedRecords, 2);
    assert.equal(await readFile(path.join(directory, "api.log"), "utf8"), "kept\n");
  } finally {
    await logs.close();
    await removeFixture(directory);
  }
});

test("日志目录或文件为链接时拒绝接管，不改写其他文件", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-path-"));
  const logsDirectory = path.join(directory, "logs"), original = path.join(directory, "original.txt");
  await mkdir(logsDirectory); await writeFile(original, "preserve-original");
  await link(original, path.join(logsDirectory, "api.log"));
  let opened: Awaited<ReturnType<typeof createRuntimeLogs>> | undefined;
  try {
    await assert.rejects(async () => { opened = await createRuntimeLogs(logsDirectory); }, /日志.*安全/);
    assert.equal(await readFile(original, "utf8"), "preserve-original");
    await unlink(path.join(logsDirectory, "api.log"));
    const junction = path.join(directory, "linked");
    await symlink(logsDirectory, junction, "junction");
    await assert.rejects(async () => { opened = await createRuntimeLogs(junction); }, /日志.*安全/);
  } finally {
    await opened?.close();
    await removeFixture(directory);
  }
});

test("同一日志目录只允许一个写者，关闭后释放所有权且旧实例不再接受记录", async () => {
  const directory = await mkdtemp(path.resolve(".local/runtime-log-owner-"));
  const first = await createRuntimeLogs(directory);
  let second: Awaited<ReturnType<typeof createRuntimeLogs>> | undefined;
  try {
    await assert.rejects(async () => { second = await createRuntimeLogs(directory); }, /日志目录.*占用/);
    await first.close();
    await assert.rejects(() => first.write("api", "after-close"), /日志.*关闭/);
    second = await createRuntimeLogs(directory);
    await second.write("api", "new-owner");
  } finally {
    await second?.close(); await first.close();
    await removeFixture(directory);
  }
});
