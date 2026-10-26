import { realpath } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import type { Db } from "@aihot/backend/db";
import { z } from "zod";
import { imageCacheRoots, scanImageFiles } from "./image-files.ts";

export const imageStorageLimit = (bytes = 3 * 1024 ** 3) => z.number().int().positive().max(3 * 1024 ** 3).parse(bytes);

/** Fixed project image roots only. Unknown/unreadable entries fail closed, never count as zero. */
export async function imageStorageUsage(db: Db) {
  const scanned = await scanImageFiles([...imageCacheRoots, "studio/image-assets"]);
  const assetRoot = path.join(config.dataDir, "studio/image-assets"), files = new Map<string, number>();
  let cacheBytes = 0;
  for (const [file, item] of scanned) {
    if (file.startsWith(assetRoot + path.sep)) files.set(file, item.bytes);
    else cacheBytes += item.bytes;
  }
  const resolved = await realpath(assetRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const root = process.platform === "win32" ? resolved?.toLowerCase() : resolved;
  const rows = await db<{ id: string; bytes: number; storage_root: string }[]>`SELECT id, bytes, storage_root FROM studio_image_assets LIMIT 100001`;
  if (rows.length > 100_000) throw new Error("图片分配计量尚未完成，暂停新增");
  let assetBytes = 0;
  for (const row of rows) {
    let physical = 0;
    if (row.storage_root === root) for (const suffix of [".image", ".image.pending"]) {
      const file = path.join(assetRoot, `${row.id}${suffix}`);
      physical += files.get(file) ?? 0; files.delete(file);
    }
    // Match each allocation with its own bytes before counting unrelated crash leftovers.
    assetBytes += Math.max(physical, Number(row.bytes));
  }
  for (const bytes of files.values()) assetBytes += bytes;
  return { cacheBytes, assetBytes, usedBytes: cacheBytes + assetBytes };
}
