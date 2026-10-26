import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import approvedBuild from "../releases/rsshub-local-build.json" with { type: "json" };

const Manifest = z.object({ schema: z.literal(1), nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/), pnpmVersion: z.literal("10.34.6"),
  files: z.number().int().min(1).max(10_000), bytes: z.number().int().min(1).max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type RsshubBuildManifest = z.infer<typeof Manifest>;
export const rsshubBuildInputs = ["LICENSE", "README.md", "dist", "package.json", "patches", "pnpm-lock.yaml", "public"];
const root = path.resolve(import.meta.dirname, "../../..");

export async function nativeRsshubDirectory(directory: string) {
  const folder = await realpath(path.resolve(root, directory));
  if (!["runtime", ".local"].some(base => folder.startsWith(path.join(root, base) + path.sep))) throw new Error("RSSHub必须使用本项目独立运行目录");
  return folder;
}

/** The operator selects an approved record; collection never creates or updates it. */
export async function loadRsshubBuildManifest(file?: string): Promise<unknown> {
  if (!file) return approvedBuild;
  try {
    if ((await stat(file)).size > 4096) throw new Error();
    return JSON.parse(await readFile(file, "utf8"));
  } catch { throw new Error("RSSHub固定清单无效或无法读取"); }
}

/** Verifies the complete approved build inputs; dependencies are rebuilt separately from the pinned lock. */
export async function verifyRsshubBuild(directory: string, input: unknown = approvedBuild) {
  directory = await nativeRsshubDirectory(directory);
  const parsed = Manifest.safeParse(input);
  if (!parsed.success) throw new Error("RSSHub固定清单无效，请使用项目已确认的构建记录");
  const manifest = parsed.data;
  if (process.versions.node !== manifest.nodeVersion) throw new Error("RSSHub固定Node版本不匹配，请使用已确认的运行时");
  if ((await readdir(directory)).some(name => !rsshubBuildInputs.includes(name) && name !== "node_modules")) throw new Error("RSSHub运行目录含未批准文件，请保留独立干净的运行目录");
  const names: string[] = [];
  let declaredBytes = 0;
  async function walk(name: string) {
    const stat = await lstat(path.join(directory, name));
    if (stat.isDirectory()) for (const child of await readdir(path.join(directory, name))) await walk(name + "/" + child);
    else {
      if (!stat.isFile()) throw new Error("RSSHub构建不允许链接或特殊文件");
      declaredBytes += stat.size;
      if (declaredBytes > 64 * 1024 * 1024 || names.length >= 10_000) throw new Error("RSSHub文件超出构建校验预算");
      names.push(name);
    }
  }
  for (const name of rsshubBuildInputs) await walk(name);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of names.sort()) {
    const content = createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, name), { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw new Error("RSSHub文件超出构建校验预算");
      content.update(chunk);
    }
    hash.update(name + "\0" + content.digest("hex") + "\n");
  }
  const sha256 = hash.digest("hex");
  if (names.length !== manifest.files || bytes !== manifest.bytes || sha256 !== manifest.sha256) throw new Error("RSSHub构建文件与固定清单不一致，请重新安装已确认版本");
  return { files: names.length, bytes, sha256 };
}
