import { lstat, mkdir, open, readdir, realpath, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { createStream } from "rotating-file-stream";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeLogStatus } from "../contracts.ts";
import { diskBudget } from "./storage-capacity.ts";

type RuntimeRole = "api" | "web" | "worker";
/** One supervisor owns its service streams. Other log families need their own quota. */
export async function createRuntimeLogs(directory: string, options: {
  fileBytes?: number; archiveFiles?: number; totalBytes?: number; availableBytes?: () => Promise<number>; secrets?: string[]; worker?: boolean;
} = {}) {
  const fileBytes = options.fileBytes ?? 8 * 1024 ** 2, archiveFiles = options.archiveFiles ?? 7;
  const limitBytes = options.totalBytes ?? 256 * 1024 ** 2;
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 128 || fileBytes > 8 * 1024 ** 2
    || !Number.isInteger(archiveFiles) || archiveFiles < 1 || archiveFiles > 7
    || !Number.isSafeInteger(limitBytes) || limitBytes < Math.max(8192, 8 * fileBytes) || limitBytes > 256 * 1024 ** 2)
    throw new Error("日志额度无效，未启动写入");
  await mkdir(directory, { recursive: true });
  directory = path.resolve(directory);
  const canonical = await realpath(directory);
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if ((await lstat(directory)).isSymbolicLink() || normalized(canonical) !== normalized(directory)) throw new Error("日志目录不安全，未接管链接");
  async function files() {
    const entries = [];
    for (const name of await readdir(directory)) if (/^(api|web|worker)\.log(?:\.[1-7]\.gz)?$/.test(name)) {
      const file = path.join(directory, name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("日志文件不安全，未接管链接或特殊文件");
      entries.push({ file, info });
    }
    return entries;
  }
  await files();
  const leasePath = path.join(directory, "runtime-logs.lock");
  const lease = await open(leasePath, "wx", 0o600).catch(() => { throw new Error("日志目录已占用或无法确认所有权"); });
  async function prune() {
    for (const entry of await files()) if (/\.gz$/.test(entry.file) && Date.now() - entry.info.mtimeMs > 7 * 86_400_000)
      await unlink(entry.file);
  }
  try { await prune(); }
  catch { await lease.close(); await unlink(leasePath); throw new Error("日志归档清理失败，未继续写入"); }
  let closing: Promise<void> | undefined;
  let tail = Promise.resolve(), state: "normal" | "limited" | "unavailable" = "normal", droppedRecords = 0;
  const maxRecord = Math.min(fileBytes, 16_384);
  const omitted = "[超长日志已省略]";
  const secrets = (options.secrets ?? []).flatMap(value => value.split(/\r?\n/)).filter(value => value.length >= 4);
  const streams: Partial<Record<RuntimeRole, ReturnType<typeof createStream>>> = {};
  const failedRoles = new Set<RuntimeRole>();
  const scope = options.worker ? "api_web_worker" : "api_web";
  const available = options.availableBytes ?? (async () => {
    const disk = await statfs(directory, { bigint: true }); return Number(disk.bavail * disk.bsize);
  });
  function streamFor(role: RuntimeRole) {
    if (!streams[role]) {
      // Size rotation stays inside the guarded write. The library's autonomous
      // interval rotation would create gzip files without checking disk pressure.
      const stream = createStream(`${role}.log`, { path: directory, size: `${fileBytes}B`, rotate: archiveFiles, compress: "gzip", mode: 0o600 });
      stream.on("error", () => { failedRoles.add(role); state = "unavailable"; });
      streams[role] = stream;
    }
    return streams[role]!;
  }
  const logs = {
    async write(role: RuntimeRole, record: string) {
      if (closing) throw new Error("日志已关闭，不能写入旧实例");
      if (role !== "api" && role !== "web" && !(role === "worker" && options.worker)) throw new Error("日志来源无效");
      let oversized = record.length > maxRecord || Buffer.byteLength(record) > maxRecord;
      if (oversized) record = omitted;
      for (const secret of secrets) record = record.replaceAll(secret, "[REDACTED]");
      if (Buffer.byteLength(record) > maxRecord) { record = omitted; oversized = true; }
      if (oversized) droppedRecords++;
      const operation = tail.then(async () => {
        try {
          await prune();
          const entries = await files(), bytes = entries.reduce((sum, entry) => sum + entry.info.size, 0);
          const largest = entries.reduce((max, entry) => Math.max(max, entry.info.size), 0);
          const reserve = Math.max(4 * (fileBytes + Math.min(fileBytes, 16_384) + 1024), 2 * largest);
          const data = Buffer.from(record + "\n");
          const free = await available();
          if (!Number.isSafeInteger(free) || free < 0) throw new Error();
          if (bytes + reserve + data.length > limitBytes || free - reserve - data.length < diskBudget.keepFreeBytes) {
            state = "limited"; droppedRecords++; return false;
          }
          const stream = streamFor(role);
          await new Promise<void>((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()));
          state = failedRoles.size ? "unavailable" : "normal";
          return true;
        } catch { state = "unavailable"; droppedRecords++; return false; }
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
    async capture(role: RuntimeRole, source: AsyncIterable<Uint8Array>) {
      const decoder = new StringDecoder("utf8");
      let pending = "", oversized = false;
      async function accept(text: string, final = false) {
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index++) {
          const part = lines[index]!;
          if (!oversized) {
            if (Buffer.byteLength(pending) + Buffer.byteLength(part) > maxRecord) { pending = ""; oversized = true; }
            else pending += part;
          }
          if (index < lines.length - 1 || (final && (pending || oversized))) {
            if (oversized) { droppedRecords++; await logs.write(role, omitted); }
            else await logs.write(role, pending.replace(/\r$/, ""));
            pending = ""; oversized = false;
          }
        }
      }
      try {
        for await (const chunk of source) for (let offset = 0; offset < chunk.length; offset += 65_536)
          await accept(decoder.write(chunk.subarray(offset, offset + 65_536)));
        await accept(decoder.end(), true);
      } catch { failedRoles.add(role); state = "unavailable"; droppedRecords++; }
    },
    async status(): Promise<RuntimeLogStatus> {
      try { return { scope, state: failedRoles.size ? "unavailable" : state, storedBytes: (await files()).reduce((sum, entry) => sum + entry.info.size, 0), limitBytes, droppedRecords }; }
      catch { return { scope, state: "unavailable", storedBytes: null, limitBytes, droppedRecords }; }
    },
    close() {
      return closing ??= (async () => {
        clearInterval(maintenance);
        await tail;
        await Promise.all(Object.values(streams).map(stream => new Promise<void>(resolve => {
          if (stream.closed) { resolve(); return; }
          stream.once("close", resolve);
          if (!stream.destroyed) stream.end();
        })));
        await lease.close(); await unlink(leasePath);
      })();
    },
  };
  const maintenance = setInterval(() => {
    if (closing) return;
    tail = tail.then(prune).catch(() => { state = "unavailable"; });
  }, 3_600_000);
  maintenance.unref();
  return logs;
}
