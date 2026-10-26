import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import type { StorageStatus } from "../contracts.ts";
import { diskBudget, reservedStorageBytes } from "./storage-capacity.ts";

const GiB = 1024 ** 3;
const limits = { media: 2 * GiB, exports: GiB / 2, backup: GiB / 2 };
const Input = z.object({ task: z.string().min(1).max(200), category: z.enum(["media", "exports", "backup"]), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
type Workspace = { id: string; task: string; category: "media" | "exports" | "backup"; bytes: number; storage_root: string };

/** Persistent task-owned temporary space. Cleanup is explicit after the caller has saved its results. */
export function createStorageWorkspaces(options: { availableBytes?: () => Promise<number> } = {}) {
  const configuredRoot = path.resolve(config.dataDir, "studio", "workspaces");
  const root = process.platform === "win32" ? configuredRoot.toLowerCase() : configuredRoot;
  function assertRoot(workspace: Workspace) {
    if (workspace.storage_root !== root) throw new Error("任务存储位置发生变化，请先核对旧目录及未完成任务");
  }
  const monitor = options.availableBytes ?? (async () => {
    await mkdir(root, { recursive: true });
    const disk = await statfs(root, { bigint: true }); return Number(disk.bavail * disk.bsize);
  });
  async function available() {
    const bytes = await monitor();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("无法确认磁盘可用空间，暂停新临时任务");
    return bytes;
  }
  async function directoryFor(id: string) {
    const directory = path.join(root, id);
    const entry = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || !(await realpath(directory)).startsWith(await realpath(root) + path.sep)))
      throw new Error("临时工作目录不安全，未清理或归还额度");
    return directory;
  }
  return {
    async reserve(input: unknown) {
      const request = Input.parse(input);
      return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const [existing] = await tx<Workspace[]>`SELECT id, task, category, bytes, storage_root FROM studio_storage_workspaces WHERE task = ${request.task}`;
        if (existing) {
          assertRoot(existing);
          if (existing.category !== request.category || existing.bytes !== request.bytes) throw new Error("任务已有不同的预留，不能覆盖仍在使用的额度");
          return { ...existing, directory: path.join(root, existing.id) };
        }
        const reservedBytes = await reservedStorageBytes(tx);
        const [category] = await tx`SELECT coalesce(sum(bytes), 0) AS bytes FROM studio_storage_workspaces WHERE category = ${request.category}`;
        if (Number(category!.bytes) + request.bytes > limits[request.category]) throw new Error("分类额度不足：临时文件需要等待清理或调整处理计划");
        if (await available() - reservedBytes - request.bytes < diskBudget.keepFreeBytes) throw new Error("可用空间不足：需为系统保留4.7GB空闲");
        const id = randomUUID();
        await mkdir(path.join(root, id), { recursive: true });
        await tx`INSERT INTO studio_storage_workspaces (id, task, storage_root, category, bytes) VALUES (${id}, ${request.task}, ${root}, ${request.category}, ${request.bytes})`;
        return { ...request, id, directory: path.join(root, id) };
      });
    },
    async status(db: Db = sql): Promise<StorageStatus> {
      return { availableBytes: await available(), reservedBytes: await reservedStorageBytes(db), keepFreeBytes: diskBudget.keepFreeBytes };
    },
    async write(input: string, name: string, chunks: AsyncIterable<Uint8Array>) {
      const id = z.uuid().parse(input);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:\.[a-zA-Z0-9]{1,10})?$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("临时文件名无效");
      return sql.begin(async tx => {
        // Keep the same lock order as reserve/cleanup, including slow OS sampling and writes.
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const [row] = await tx<Workspace[]>`SELECT id, task, category, bytes, storage_root FROM studio_storage_workspaces WHERE id = ${id} FOR UPDATE`;
        if (!row) throw new Error("临时任务预留不存在或已清理");
        assertRoot(row);
        const directory = await directoryFor(row.id);
        let used = 0;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile()) throw new Error("临时目录含非普通文件，暂停写入");
          used += (await stat(path.join(directory, entry.name))).size;
        }
        const file = path.join(directory, name), handle = await open(file, "wx");
        let bytesWritten = 0;
        try {
          for await (const chunk of chunks) {
            if (used + bytesWritten + chunk.byteLength > row.bytes) throw new Error("实际文件字节超过任务预留，未接受截断结果");
            if (await available() - chunk.byteLength < diskBudget.keepFreeBytes) throw new Error("写入空间不足：任务已保留，请等待系统恢复4.7GB留白");
            await handle.writeFile(chunk); bytesWritten += chunk.byteLength;
          }
          await handle.sync();
          return { bytesWritten };
        } catch (error) {
          await handle.close();
          await rm(file, { force: true });
          throw error;
        } finally { await handle.close(); }
      });
    },
    async cleanup(input: string) {
      const id = z.uuid().parse(input);
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const [row] = await tx<Workspace[]>`SELECT id, task, category, bytes, storage_root FROM studio_storage_workspaces WHERE id = ${id} FOR UPDATE`;
        if (!row) return;
        assertRoot(row);
        const directory = await directoryFor(row.id);
        try { await rm(directory, { recursive: true, force: true }); }
        catch { throw new Error("临时文件清理失败，保留预留额度，请解除文件占用后重试"); }
        await tx`DELETE FROM studio_storage_workspaces WHERE id = ${id}`;
      });
    },
  };
}
