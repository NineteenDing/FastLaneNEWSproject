import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { audit, Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue, shutdownSignal } from "@aihot/backend/jobs/queue";
import { streamDatabaseBackup, verifyDatabaseBackup } from "@aihot/backend/operations/database-backup";
import { modelBudgetBackupFiles } from "@aihot/backend/providers/llm-budget";
import { createCollectionAdmission } from "./collection-admission.ts";
import { scanImageFiles } from "./image-files.ts";
import { diskBudget, reservedStorageBytes } from "./storage-capacity.ts";

const key = "studio.backup.current", root = path.resolve(import.meta.dirname, "../../..");
type Summary = { scope?: "data" | "portable"; id: string; at: string; bytes: number; files: number; externalDeclared: boolean; targetKey: string };
type Current = { id: string; jobId: string; targetKey: string; state: "queued" | "running" | "completed" | "failed"; last?: Summary; lastDaily?: Summary; error?: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const configuredPath = () => process.env.STUDIO_BACKUP_DIRECTORY?.trim() || null;
const externalDeclared = () => process.env.STUDIO_BACKUP_EXTERNAL === "true";
const targetKey = () => digest(path.resolve(root, configuredPath() ?? "not-configured"));
export const studioBackupConfigured = () => !!configuredPath() && externalDeclared();
async function current() { return (await sql<{ value: Current }[]>`SELECT value FROM settings WHERE key = ${key}`)[0]?.value ?? null; }
async function persist(value: Current, db: Db = sql) {
  await db`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${db.json(value as never)}, 'studio:backup')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}

export async function studioBackupStatus() {
  const saved = await current();
  const [job] = saved && ["queued", "running"].includes(saved.state) ? await sql`SELECT state FROM pgboss.job WHERE name = 'studio.backup.capture' AND id = ${saved.jobId}` : [];
  const interrupted = saved && ["queued", "running"].includes(saved.state) && !["created", "retry", "active"].includes(job?.state);
  const last = saved?.last, daily = saved?.lastDaily ?? (last?.scope !== "portable" ? last : undefined);
  return { configured: !!configuredPath(), externalDeclared: externalDeclared(),
    protected: !!daily && daily.externalDeclared && daily.targetKey === targetKey() && externalDeclared() && Date.now() - Date.parse(daily.at) < 50 * 3600_000,
    state: interrupted ? "failed" : saved?.state ?? "not_started",
    last: last ? { id: last.id, at: last.at, bytes: last.bytes, files: last.files, externalDeclared: last.externalDeclared } : null,
    error: interrupted ? "上次备份任务已中断，可重新提交；未完成目录保留供检查" : saved?.error ?? null };
}

export async function submitStudioBackup(input: unknown, actor: string) {
  const options = z.union([z.object({ scope: z.literal("portable"), destination: z.string().trim().min(1).max(2000) }).strict(), z.object({}).strict()]).parse(input);
  const manual = "scope" in options ? await backupDestination(options.destination, true) : null;
  if (!manual && !configuredPath()) throw new Conflict("请先在运行配置中指定备份目录；未配置时数据尚未受到完整备份保护");
  await ensureQueue(studioBackupQueue.name, studioBackupQueue.options);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('studio-backup-submit'))`;
    const [before] = await tx<{ value: Current }[]>`SELECT value FROM settings WHERE key = ${key}`;
    const [old] = before ? await tx`SELECT state FROM pgboss.job WHERE name = ${studioBackupQueue.name} AND id = ${before.value.jobId}` : [];
    if (old && ["created", "retry", "active"].includes(old.state)) return { queued: false, id: before!.value.id, jobId: before!.value.jobId };
    const id = new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomUUID(), target = manual ? digest(manual) : targetKey();
    const jobId = await enqueueOn(studioBackupQueue, { id, target, ...(manual ? { scope: "portable" as const, destination: manual } : {}) }, { singletonKey: "complete-studio-backup", group: { id: "studio-backup" } }, tx);
    if (!jobId) throw new Conflict("已有备份正在排队，请刷新查看状态");
    const value: Current = { id, jobId, targetKey: target, state: "queued", ...(before?.value.last ? { last: before.value.last } : {}), ...(before?.value.lastDaily ? { lastDaily: before.value.lastDaily } : {}) };
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${tx.json(value as never)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await audit(actor, "studio.backup.submit", "studio.backup", null, null, { id }, { db: tx });
    return { queued: true, id, jobId };
  });
}

async function capture(id: string, target: string, manual?: string) {
  const saved = await current(); if (!saved || saved.id !== id || saved.state === "completed") return;
  const signal = AbortSignal.any([shutdownSignal.signal, AbortSignal.timeout(25 * 60_000)]);
  await persist({ ...saved, state: "running", error: undefined });
  try {
    if (manual ? target !== digest(manual) : !configuredPath() || target !== targetKey()) throw new Error("备份位置已改变");
    const destination = await backupDestination(manual ?? path.resolve(root, configuredPath()!), !!manual), source = await realpath(config.dataDir);
    const sameVolume = (await stat(source)).dev === (await stat(destination)).dev;
    const folder = path.join(destination, id); await mkdir(folder);
    const files: Array<{ name: string; bytes: number; sha256: string }> = [];
    await sql.begin(async tx => {
      // Hold image publication/pruning, so the dump and immutable bytes remain paired.
      await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
      const reserved = sameVolume ? await reservedStorageBytes(tx) : 0, localLimit = 512 * 1024 ** 2;
      let localBytes = 0, entries = 0;
      if (sameVolume && !manual) for (const name of await readdir(destination)) {
        if (name === id) continue;
        if (!/^\d{8}-[a-f0-9-]{36}$/.test(name)) throw new Error("同盘备份须使用专用目录");
        const walk = async (directory: string, depth: number): Promise<void> => {
          const parent = await lstat(directory);
          if (depth > 6 || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error("备份目录异常");
          for (const name of await readdir(directory)) {
            if (++entries > 100000) throw new Error("备份目录检查超限");
            const file = path.join(directory, name), entry = await lstat(file);
            if (entry.isSymbolicLink()) throw new Error("备份目录含链接");
            if (entry.isDirectory()) await walk(file, depth + 1);
            else if (entry.isFile()) localBytes += entry.size;
            else throw new Error("备份目录含特殊文件");
            if (localBytes > localLimit) throw new Error("同盘备份已达512MiB限额");
          }
        };
        await walk(path.join(destination, name), 0);
      }
      async function write(name: string, chunks: AsyncIterable<Uint8Array>) {
        const file = path.join(folder, ...name.split("/")); await mkdir(path.dirname(file), { recursive: true });
        const handle = await open(file, "wx", 0o600), hash = createHash("sha256"); let bytes = 0;
        try {
          for await (const chunk of chunks) {
            signal.throwIfAborted();
            if (sameVolume && !manual && localBytes + chunk.byteLength > localLimit) throw new Error("同盘备份超过512MiB限额");
            const space = await statfs(destination, { bigint: true });
            if (Number(space.bavail * space.bsize) - reserved - chunk.byteLength < diskBudget.keepFreeBytes) throw new Error("备份空间不足，保留4.7GB底线");
            await handle.writeFile(chunk); hash.update(chunk); bytes += chunk.byteLength; if (sameVolume) localBytes += chunk.byteLength;
          }
          await handle.sync();
        } finally { await handle.close(); }
        const sha256 = hash.digest("hex"), assetId = /^data\/studio\/image-assets\/([a-f0-9]{64})\.image$/.exec(name)?.[1];
        if (assetId && assetId !== sha256) throw new Error("图片素材摘要不符");
        files.push({ name, bytes, sha256 });
      }
      const one = async function* (bytes: Uint8Array) { yield bytes; };
      await write("database.dump", streamDatabaseBackup(signal));
      await verifyDatabaseBackup(path.join(folder, "database.dump"));
      const imageFiles = await scanImageFiles(["studio/image-assets", "studio/source-icons", "uploads", "feedback-screenshots"]);
      const ready = await tx<{ id: string; bytes: number }[]>`SELECT id, bytes FROM studio_image_assets WHERE state = 'ready'`;
      for (const image of ready) if (imageFiles.get(path.join(config.dataDir, "studio/image-assets", image.id + ".image"))?.bytes !== Number(image.bytes))
        throw new Error("数据库中的图片素材缺失或大小不符");
      for (const [file] of imageFiles)
        await write("data/" + path.relative(config.dataDir, file).split(path.sep).join("/"), createReadStream(file, { highWaterMark: 1024 ** 2, signal }));
      for (const [name, bytes] of Object.entries(modelBudgetBackupFiles())) await write("data/llm-budget/" + name, one(bytes));
      const control = await readFile(path.join(config.dataDir, "collection-control/state.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (control) await write("data/collection-control/state.json", one(control));
      if (manual) for (const file of await programFiles()) await write("program/" + path.relative(root, file).split(path.sep).join("/"), createReadStream(file, { highWaterMark: 1024 ** 2, signal }));
      const manifest = { scope: manual ? "portable" : "data", format: 1, id, at: new Date().toISOString(), sourceDataRoot: source, requiresOriginalSessionSecret: true,
        externalDeclared: !manual && externalDeclared() && !sameVolume, files, notes: ["预算账本晚于数据库快照捕获，可能比数据库更保守。", "异路径恢复须先重定位图片存储根；不要覆盖运行中的数据库。", manual ? "含程序与根.env（若存在），请保管目录中的密钥；不含node_modules、模型、缓存或临时视频，仍需重装固定依赖。" : "原SESSION_SECRET等密钥需单独安全保存；不含.env、模型、缓存或临时视频。"] };
      await write("manifest.json", one(Buffer.from(JSON.stringify(manifest, null, 2) + "\n")));
      const last: Summary = { scope: manual ? "portable" : "data", id, at: manifest.at, bytes: files.reduce((total, file) => total + file.bytes, 0), files: files.length,
        externalDeclared: manifest.externalDeclared, targetKey: target };
      await persist({ ...saved, state: "completed", last, lastDaily: manual ? saved.lastDaily ?? (saved.last?.scope !== "portable" ? saved.last : undefined) : last, error: undefined }, tx);
    });
  } catch {
    await persist({ ...saved, state: "failed", error: "完整备份未完成，请检查目标目录、空间或数据库工具；未完成目录保留供核对，不计为成功备份" });
    throw new Error("完整备份未完成，请检查配置、空间和运行依赖");
  }
}

export const studioBackupQueue = defineQueue<{ id: string; target: string; scope?: "portable"; destination?: string }>({ name: "studio.backup.capture",
  options: { policy: "singleton", retryLimit: 0, expireInSeconds: 1800 }, executionGroup: "studio-creator-media",
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission({ heavy: true, enabled: () => true }),
  async run(jobs) { for (const job of jobs) await capture(job.id, job.target, job.scope === "portable" ? job.destination : undefined); },
});

async function backupDestination(selected: string, portable: boolean) {
  if (!path.isAbsolute(selected)) throw new Conflict("备份位置须为服务器上的完整绝对路径");
  const info = await lstat(selected).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Conflict("请先准备一个真实可写的目录，不能使用链接");
  const destination = await realpath(selected), source = await realpath(config.dataDir);
  const inside = (base: string, value: string) => { const relative = path.relative(base, value); return !relative || !relative.startsWith("..") && !path.isAbsolute(relative); };
  if (inside(source, destination) || inside(destination, source) || path.parse(destination).root === destination
    || ["FastlaneNews", "情报站"].some(name => inside(path.resolve(root, "..", name), destination))
    || portable && (inside(root, destination) || inside(destination, root))) throw new Conflict("备份目录不能与程序、运行数据相互包含，或写入原只读来源");
  return destination;
}

async function programFiles() {
  const files: string[] = []; let entries = 0;
  const skip = new Set(["node_modules", ".git", ".local", ".venv", "venv", "__pycache__", ".cache", "models", "weights", "pgdata", "tests", ".scratch", ".impeccable"]);
  const walk = async (file: string, depth: number): Promise<void> => {
    if (++entries > 100000 || depth > 24) throw new Error("程序副本文件范围超限");
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error("程序目录含链接，未复制不确定目标");
    if (info.isDirectory()) { for (const name of await readdir(file)) if (!skip.has(name)) await walk(path.join(file, name), depth + 1); }
    else if (info.isFile() && info.nlink === 1) files.push(file); else throw new Error("程序目录含特殊文件");
  };
  for (const name of ["apps", "packages", "modules", "database", "site", "industry", "scripts", "vendor", "docs", "package.json", "package-lock.json", ".env", ".env.example", "tsconfig.base.json", "LICENSE", "NOTICE", "GOAL.md", "AGENTS.md"]) await walk(path.join(root, name), 0);
  return files;
}

/** Existing ops.backup waits for admitted completion; queuing alone is not a successful backup. */
export async function scheduledStudioBackup() {
  const queued = await submitStudioBackup({}, "system:backup"), deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    shutdownSignal.signal.throwIfAborted(); const state = await studioBackupStatus();
    if (state.state === "completed" && state.last?.id === queued.id) {
      if (!state.protected) throw new Error("仅同盘副本或机外声明已变更，尚未形成独立备份保护");
      return { at: state.last.at, uploaded: true, objects: [] };
    }
    if (state.state === "failed") throw new Error("完整备份未完成");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("完整备份仍未完成，请检查持久任务");
}
