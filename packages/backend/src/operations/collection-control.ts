import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.ts";

const directory = join(config.dataDir, "collection-control"), filename = join(directory, "state.json"), lock = join(directory, "state.lock");
export type CollectionControl = { version: number | null; requestedEnabled: boolean | null; runtimeAllowed: boolean; enabled: boolean; state: "ready" | "unavailable"; updatedAt: string | null };
export class CollectionControlConflict extends Error {}
export const collectionRuntimeAllowed = () => process.env.COLLECT_ENABLED === "true";

/** Read on each admission, including other processes. Invalid saved state always pauses pickup. */
export function collectionControlState(): CollectionControl {
  const runtimeAllowed = collectionRuntimeAllowed();
  try {
    let value: { version: number; enabled: boolean; updatedAt: string | null };
    try {
      const saved = JSON.parse(readFileSync(filename, "utf8"));
      if (!saved || saved.format !== 1 || !Number.isSafeInteger(saved.version) || saved.version < 1 || typeof saved.enabled !== "boolean"
        || typeof saved.updatedAt !== "string" || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error("invalid collection state");
      value = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value = { version: 0, enabled: true, updatedAt: null };
    }
    return { version: value.version, requestedEnabled: value.enabled, runtimeAllowed, enabled: runtimeAllowed && value.enabled, state: "ready", updatedAt: value.updatedAt };
  } catch {
    return { version: null, requestedEnabled: null, runtimeAllowed, enabled: false, state: "unavailable", updatedAt: null };
  }
}
export const collectionEnabled = () => process.env.STUDIO_WORKER_BOOTSTRAPPING !== "true" && collectionControlState().enabled;

/** Reuse the budget ledger's local lock + fsync + atomic publication pattern; never alter startup permission. */
export function saveCollectionControl(input: { version: number; enabled: boolean }, actor: string): CollectionControl {
  if (!Number.isSafeInteger(input.version) || input.version < 0 || typeof input.enabled !== "boolean") throw new Error("采集设置无效");
  mkdirSync(directory, { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  if (fd === undefined) throw new Error("采集设置正在被占用，请检查后重试");
  const temporary = join(directory, `state-${randomUUID()}.tmp`);
  let output: number | undefined;
  try {
    const before = collectionControlState();
    if (before.state !== "ready") throw new Error("采集设置无法读取，已暂停新采集；请检查数据目录");
    if (input.version !== before.version) throw new CollectionControlConflict("采集状态已在其他窗口修改，请刷新后重试");
    if (input.enabled && !before.runtimeAllowed) throw new CollectionControlConflict("启动配置尚未允许采集，请先启用 COLLECT_ENABLED 并重启服务");
    const next = { format: 1, version: input.version + 1, enabled: input.enabled, updatedAt: new Date().toISOString(), updatedBy: actor };
    output = openSync(temporary, "wx", 0o600); writeFileSync(output, JSON.stringify(next) + "\n"); fsyncSync(output); closeSync(output); output = undefined;
    renameSync(temporary, filename);
    return collectionControlState();
  } finally {
    try { if (output !== undefined) closeSync(output); } finally {
      try { unlinkSync(temporary); } catch {}
      try { closeSync(fd); } finally { unlinkSync(lock); }
    }
  }
}
