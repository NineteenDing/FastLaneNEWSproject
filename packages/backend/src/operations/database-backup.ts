// Database backup command contract shared with operations/backup.ts. No password in process arguments.
import { spawn, execFile } from "node:child_process";
import { addAbortListener } from "node:events";
import { promisify } from "node:util";
import { config } from "../config.ts";

export function databaseBackupConnection() {
  const database = new URL(config.databaseUrl), password = decodeURIComponent(database.password); database.password = "";
  return { url: database.toString(), env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } };
}

/** Bounded stdout stream: destination owns capacity checks; no local dump staging. */
export async function* streamDatabaseBackup(signal?: AbortSignal): AsyncGenerator<Buffer> {
  signal?.throwIfAborted(); const connection = databaseBackupConnection();
  const child = spawn("pg_dump", ["--format=custom", "--compress=6", "--no-owner", connection.url],
    { env: connection.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let failed = false;
  const closed = new Promise<number | null>(resolve => { child.once("error", () => { failed = true; }); child.once("close", resolve); });
  child.stderr.resume(); // Never expose database connection details from a child error.
  const timeout = setTimeout(() => { failed = true; child.kill(); }, 15 * 60_000);
  const abort = signal ? addAbortListener(signal, () => child.kill()) : undefined;
  try {
    for await (const chunk of child.stdout) { signal?.throwIfAborted(); yield Buffer.from(chunk); }
    if (await closed !== 0 || failed) throw new Error("数据库备份未完整生成");
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timeout); abort?.[Symbol.dispose]();
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

export async function verifyDatabaseBackup(file: string) {
  try { await promisify(execFile)("pg_restore", ["--list", file], { windowsHide: true, maxBuffer: 16 * 1024 ** 2, timeout: 60000 }); }
  catch { throw new Error("数据库备份格式校验未通过"); }
}
