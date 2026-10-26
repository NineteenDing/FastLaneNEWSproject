// Cache publication is shared by image renditions, preparation markers and share cards.
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { serverModules } from "../modules.ts";

export class ImageStorageUnavailable extends Error {}

export async function saveImageCache(files: Array<{ file: string; body: Buffer | string }>): Promise<void> {
  const bytes = files.reduce((sum, value) => sum + Buffer.byteLength(value.body), 0);
  const write = async () => {
    for (const { file, body } of files) {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, body, { flag: "wx" }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
  };
  const policies = serverModules().flatMap(module => module.imageCacheWrite ? [module.imageCacheWrite] : []);
  if (policies.length > 1) throw new ImageStorageUnavailable("图片缓存存在重复存储策略");
  if (policies[0]) await policies[0](bytes, write);
  else await write();
}
