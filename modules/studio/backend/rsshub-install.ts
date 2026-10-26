import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdir, open, realpath, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { devNull } from "node:os";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import { rsshubBuildInputs, verifyRsshubBuild } from "./rsshub-build.ts";
import { diskBudget } from "./storage-capacity.ts";

const root = path.resolve(import.meta.dirname, "../../..");

async function installationPath(value: string) {
  const name = path.resolve(root, value), parent = await realpath(path.dirname(name));
  if (!["runtime", ".local"].some(base => parent === path.join(root, base) || parent.startsWith(path.join(root, base) + path.sep)))
    throw new Error("RSSHub安装只允许本项目runtime/.local独立目录");
  return path.join(parent, path.basename(name));
}

export async function installRsshub(options: { sourceDirectory: string; targetDirectory: string; storeDirectory: string; pnpmCli: string; manifest?: unknown; offline?: boolean;
  availableBytes?: (directory: string) => Promise<bigint> }) {
  const build = await verifyRsshubBuild(options.sourceDirectory, options.manifest);
  const result = await promisify(execFile)(process.execPath, [options.pnpmCli, "--version"],
    { env: localProcessEnvironment(), windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  if (result.stdout.trim() !== "10.34.6") throw new Error("RSSHub固定pnpm版本不匹配，请准备10.34.6工具");
  const target = await installationPath(options.targetDirectory), store = await installationPath(options.storeDirectory);
  const storeStat = await lstat(store).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (storeStat && (!storeStat.isDirectory() || storeStat.isSymbolicLink())) throw new Error("RSSHub缓存目录不能是链接或特殊文件");
  const source = await realpath(path.resolve(root, options.sourceDirectory));
  for (const [left, right] of [[source, target], [source, store], [target, store]] as const) {
    const a = process.platform === "win32" ? left.toLowerCase() : left, b = process.platform === "win32" ? right.toLowerCase() : right;
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw new Error("RSSHub构建、安装与缓存目录不能重叠");
  }
  if (await lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))
    throw new Error("RSSHub安装目标目录已存在，请选择新的独立版本目录");
  const available = options.availableBytes ?? (async directory => { const disk = await statfs(directory, { bigint: true }); return disk.bavail * disk.bsize; });
  if (await available(path.dirname(target)) < BigInt(diskBudget.keepFreeBytes) + 1024n ** 3n) throw new Error("RSSHub安装空间不足：需保留4.7GB空闲及至少1GiB安装余量");
  const lock = await open(target + ".installing", "wx").catch(() => { throw new Error("RSSHub目标正在安装或有未完成安装记录，请先检查状态"); });
  let created = false, complete = false;
  try {
    // pnpm uses absolute Windows junctions: installing then renaming would break dependencies.
    await mkdir(target); created = true;
    for (const name of rsshubBuildInputs) await cp(path.join(source, name), path.join(target, name), { recursive: true });
    await verifyRsshubBuild(target, options.manifest);
    const env = { ...localProcessEnvironment(), PATH: path.dirname(process.execPath) + path.delimiter + (localProcessEnvironment().PATH ?? localProcessEnvironment().Path ?? ""),
      CI: "true", COREPACK_ENABLE_NETWORK: "0" };
    await promisify(execFile)(process.execPath, [path.resolve(options.pnpmCli), "install", "--prod", "--frozen-lockfile", "--ignore-scripts",
      "--ignore-pnpmfile", "--ignore-workspace", "--config.manage-package-manager-versions=false", "--config.side-effects-cache=false",
      "--config.package-import-method=copy", "--config.verify-store-integrity=true", "--config.registry=https://registry.npmjs.org/",
      "--config.userconfig=" + devNull, "--config.globalconfig=" + devNull, "--store-dir", store, ...(options.offline ? ["--offline"] : [])],
      { cwd: target, env, windowsHide: true, timeout: 180_000, maxBuffer: 256 * 1024 })
      .catch(() => { throw new Error("RSSHub生产依赖安装失败，请检查固定工具、锁文件和可达性"); });
    await verifyRsshubBuild(target, options.manifest);
    if (await available(path.dirname(target)) < BigInt(diskBudget.keepFreeBytes)) throw new Error("RSSHub安装后空闲不足4.7GB，未启用新版本");
    complete = true;
    return { ...build, dependencies: "installed_from_lock" as const };
  } finally {
    let cleaned = !created;
    try {
      if (created && !complete && target.startsWith(path.dirname(target) + path.sep)) { await rm(target, { recursive: true, force: true }); cleaned = true; }
    } catch { throw new Error("RSSHub失败安装目录清理失败，已保留安装标记阻止采集，请检查文件占用"); }
    finally { await lock.close(); if (complete || cleaned) await rm(target + ".installing"); }
  }
}
