import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";

export const imageCacheRoots = ["imgcache", "ogcache", "studio/source-icons"];

/** One bounded walk for image accounting and retention; never follow links or count unknown as zero. */
export async function scanImageFiles(leaves: string[]): Promise<Map<string, { bytes: number; mtimeMs: number }>> {
  const files = new Map<string, { bytes: number; mtimeMs: number }>();
  let entries = 0;
  const deadline = performance.now() + 5000;
  async function scan(directory: string, depth = 0): Promise<void> {
    const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || depth > 2) throw new Error("图片目录无法安全读取");
    for await (const entry of await opendir(directory)) {
      if (++entries > 100_000 || performance.now() > deadline) throw new Error("图片存储扫描尚未完成");
      const file = path.join(directory, entry.name), item = await lstat(file);
      if (item.isSymbolicLink()) throw new Error("图片目录含链接，停止操作");
      if (item.isDirectory()) await scan(file, depth + 1);
      else if (item.isFile() && item.nlink === 1) files.set(file, { bytes: item.size, mtimeMs: item.mtimeMs });
      else throw new Error("图片目录含非普通文件，停止操作");
    }
  }
  const parent = await lstat(path.join(config.dataDir, "studio")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (parent?.isSymbolicLink() || (parent && !parent.isDirectory())) throw new Error("图片目录无法安全读取");
  for (const leaf of leaves) await scan(path.join(config.dataDir, leaf));
  return files;
}
