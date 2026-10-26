import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { sha256 } from "@aihot/backend/lib/ids";
import { createStorageWorkspaces } from "./storage-workspaces.ts";
import type { ImageAssetStatus } from "../contracts.ts";
import { imageStorageLimit, imageStorageUsage } from "./image-capacity.ts";

const Id = z.string().regex(/^[a-f0-9]{64}$/);
const Type = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
interface Asset { id: string; storage_root: string; bytes: number; content_type: string; state: "staging" | "ready" }

/** Durable image bytes. Callers validate/decode images before storing; this pool never executes files. */
export function createImageAssets(options: { availableBytes?: () => Promise<number>; limitBytes?: number } = {}) {
  const configuredRoot = path.resolve(config.dataDir, "studio", "image-assets");
  const limitBytes = imageStorageLimit(options.limitBytes);
  const storage = createStorageWorkspaces({ availableBytes: options.availableBytes });
  async function directory() {
    await mkdir(configuredRoot, { recursive: true });
    const info = await lstat(configuredRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("图片素材目录不安全");
    const root = await realpath(configuredRoot);
    return process.platform === "win32" ? root.toLowerCase() : root;
  }
  function assertRoot(row: Asset, root: string) {
    if (row.storage_root !== root) throw new Error("图片素材存储位置发生变化，请先核对旧目录");
  }
  async function bytesAt(root: string, id: string) {
    const file = path.join(root, `${id}.image`);
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("图片素材文件不安全");
    const body = await readFile(file);
    if (sha256(body) !== id) throw new Error("图片素材校验失败");
    return body;
  }
  async function asset(id: string, db: Db = sql) {
    return (await db<Asset[]>`SELECT id, storage_root, bytes, content_type, state FROM studio_image_assets WHERE id = ${id}`)[0];
  }
  async function removeOwnedFile(file: string) {
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("图片素材文件不安全，未清理或归还额度");
    await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return {
    async put(input: { body: Buffer; type: string }) {
      const type = Type.parse(input.type), body = Buffer.from(input.body);
      if (!body.length || body.length > 15 * 1024 ** 2) throw new Error("图片素材必须在15MiB以内");
      const id = sha256(body), root = await directory();
      // A durable allocation precedes any write. Failed publication remains visible for retry.
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const existing = await asset(id, tx);
        if (existing) { assertRoot(existing, root); return; }
        if ((await imageStorageUsage(tx)).usedBytes + body.length > limitBytes) throw new Error("图片素材额度不足，暂停新增图片");
        const capacity = await storage.status(tx);
        if (capacity.availableBytes - capacity.reservedBytes - body.length < capacity.keepFreeBytes) throw new Error("可用空间不足：图片需为系统保留4.7GB空闲");
        await tx`INSERT INTO studio_image_assets (id, storage_root, bytes, content_type, state)
          VALUES (${id}, ${root}, ${body.length}, ${type}, 'staging')`;
      });
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const row = await asset(id, tx);
        if (!row) throw new Error("图片素材预留已失效，请重试");
        assertRoot(row, root);
        const file = path.join(root, `${id}.image`), temporary = `${file}.pending`;
        // The shared lock excludes active writers. Reuse one staging name across retries/restarts.
        await removeOwnedFile(temporary);
        if (!(await bytesAt(root, id))) {
          const capacity = await storage.status(tx);
          const extra = row.state === "staging" ? 0 : body.length;
          if (capacity.availableBytes - capacity.reservedBytes - extra < capacity.keepFreeBytes) throw new Error("可用空间不足：图片预留已保留，请等待恢复");
          const handle = await open(temporary, "wx");
          try {
            await handle.writeFile(body); await handle.sync(); await handle.close();
            await rename(temporary, file);
          } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        }
        await tx`UPDATE studio_image_assets SET state = 'ready', touched_at = now() WHERE id = ${id}`;
      });
      return { id, bytes: body.length, type };
    },
    async read(input: string) {
      const id = Id.parse(input);
      try {
        const row = await asset(id);
        if (!row || row.state !== "ready") return null;
        const root = await directory(); assertRoot(row, root);
        const body = await bytesAt(root, id);
        return body ? { body, type: row.content_type } : null;
      } catch (cause) { throw new Error("图片素材读取失败，请检查存储状态", { cause }); }
    },
    async setReferences(input: string, images: string[], transaction?: Tx) {
      const owner = z.string().min(1).max(200).parse(input), ids = [...new Set(z.array(Id).max(1000).parse(images))];
      const persist = async (tx: Tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const root = await directory();
        for (const id of ids) {
          const row = await asset(id, tx);
          if (!row || row.state !== "ready") throw new Error("图片素材尚未保存，未改变原引用");
          assertRoot(row, root);
          if (!(await bytesAt(root, id))) throw new Error("图片素材缺失，未改变原引用");
        }
        const old = await tx<{ image_id: string }[]>`DELETE FROM studio_image_references WHERE owner = ${owner} RETURNING image_id`;
        if (old.length) await tx`UPDATE studio_image_assets SET touched_at = now() WHERE id = ANY(${old.map(row => row.image_id)}::text[])`;
        if (ids.length) await tx`INSERT INTO studio_image_references ${tx(ids.map(image_id => ({ owner, image_id })), "owner", "image_id")}`;
      };
      return transaction ? persist(transaction) : sql.begin(persist);
    },
    async prune(before: Date, onlyIds?: string[]) {
      if (!Number.isFinite(before.getTime())) throw new Error("素材清理时间无效");
      onlyIds?.forEach(id => Id.parse(id));
      return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const root = await directory();
        const rows = await tx<Asset[]>`SELECT id, storage_root, bytes, content_type, state FROM studio_image_assets a
          WHERE touched_at < ${before} AND (${onlyIds === undefined} OR id = ANY(${onlyIds ?? []}::text[])) AND NOT EXISTS (SELECT 1 FROM studio_image_references r WHERE r.image_id = a.id)
          ORDER BY touched_at, id LIMIT 100`;
        for (const row of rows) {
          assertRoot(row, root);
          const file = path.join(root, `${row.id}.image`);
          await removeOwnedFile(`${file}.pending`);
          await removeOwnedFile(file);
          await tx`DELETE FROM studio_image_assets WHERE id = ${row.id}`;
        }
        return { removed: rows.length };
      });
    },
    async status(): Promise<ImageAssetStatus> {
      const [row] = await sql`SELECT coalesce(sum(bytes) FILTER (WHERE state = 'ready'), 0) AS stored,
        coalesce(sum(bytes) FILTER (WHERE state = 'staging'), 0) AS pending FROM studio_image_assets`;
      return { scope: "managed_image_allocations", storedBytes: Number(row!.stored), pendingBytes: Number(row!.pending), limitBytes };
    },
  };
}
