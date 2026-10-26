import { sql } from "@aihot/backend/db";
import { ImageStorageUnavailable } from "@aihot/backend/media/cache";
import { createStorageWorkspaces } from "./storage-workspaces.ts";
import { imageStorageLimit, imageStorageUsage } from "./image-capacity.ts";
import type { ImageStorageStatus } from "../contracts.ts";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { imageCacheRoots, scanImageFiles } from "./image-files.ts";

/** The image cache and durable images use the same storage-space transaction lock. */
export function createImageStorage(options: { availableBytes?: () => Promise<number>; limitBytes?: number } = {}) {
  const temporary = createStorageWorkspaces(options);
  const limitBytes = imageStorageLimit(options.limitBytes);
  return {
    async status(): Promise<ImageStorageStatus> {
      try {
        const usage = await imageStorageUsage(sql);
        return { scope: "configured_image_storage", state: usage.usedBytes >= limitBytes ? "limited" : "normal", ...usage, limitBytes };
      } catch {
        return { scope: "configured_image_storage", state: "unavailable", cacheBytes: null, assetBytes: null, usedBytes: null, limitBytes };
      }
    },
    async write(bytes: number, write: () => Promise<void>) {
      try { await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        if ((await imageStorageUsage(tx)).usedBytes + bytes > limitBytes)
          throw new ImageStorageUnavailable("图片存储额度不足，请等待清理或扩容");
        const capacity = await temporary.status(tx);
        if (capacity.availableBytes - capacity.reservedBytes - bytes < capacity.keepFreeBytes)
          throw new ImageStorageUnavailable("图片存储空间不足，请等待清理或扩容");
        await write();
      }); } catch (cause) {
        if (cause instanceof ImageStorageUnavailable) throw cause;
        throw new ImageStorageUnavailable("图片存储状态无法确认，请稍后重试", { cause });
      }
    },
    async prune(before: Date): Promise<number> {
      if (!Number.isFinite(before.getTime())) throw new Error("图片清理截止时间无效");
      try { return await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
        const studio = path.join(config.dataDir, "studio");
        const icons = await tx<{ icon_key: string }[]>`SELECT icon_key FROM studio_source_metadata WHERE icon_key IS NOT NULL LIMIT 100001`;
        if (icons.length > 100_000) throw new Error("头像引用尚未完整读取，停止清理");
        const protectedIcons = new Set(icons.map(row => path.join(studio, "source-icons", row.icon_key)));
        const files = await scanImageFiles(imageCacheRoots);
        let removed = 0;
        for (const [file, item] of files) if (item.mtimeMs < before.getTime() && !protectedIcons.has(file)) {
          await unlink(file); removed++;
        }
        return removed;
      }); } catch (cause) { throw new ImageStorageUnavailable("图片缓存清理失败，未确认删除的文件将在后续重试", { cause }); }
    },
  };
}
