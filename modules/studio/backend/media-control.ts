import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "@aihot/backend/config";

const directory = join(config.dataDir, "studio-media-control"), filename = join(directory, "state.json"), lock = join(directory, "state.lock");
export type MediaControl = { version: number | null; requestedEnabled: boolean | null; runtimeAllowed: boolean; enabled: boolean; state: "ready" | "unavailable"; updatedAt: string | null };
export class MediaControlConflict extends Error {}
export const mediaRuntimeAllowed = () => process.env.STUDIO_MEDIA_ENABLED === "true";

/** Read on each admission, including other processes. Invalid saved state always pauses pickup. */
export function mediaControlState(): MediaControl {
  const runtimeAllowed = mediaRuntimeAllowed();
  try {
    let value: { version: number; enabled: boolean; updatedAt: string | null };
    try {
      const saved = JSON.parse(readFileSync(filename, "utf8"));
      if (!saved || saved.format !== 1 || !Number.isSafeInteger(saved.version) || saved.version < 1 || typeof saved.enabled !== "boolean"
        || typeof saved.updatedAt !== "string" || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error("invalid collection state");
      value = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value = { version: 0, enabled: false, updatedAt: null };
    }
    return { version: value.version, requestedEnabled: value.enabled, runtimeAllowed, enabled: runtimeAllowed && value.enabled, state: "ready", updatedAt: value.updatedAt };
  } catch {
    return { version: null, requestedEnabled: null, runtimeAllowed, enabled: false, state: "unavailable", updatedAt: null };
  }
}
export const mediaEnabled = () => mediaControlState().enabled;

/** Reuse the budget ledger's local lock + fsync + atomic publication pattern; never alter startup permission. */
export function saveMediaControl(input: { version: number; enabled: boolean }, actor: string): MediaControl {
  if (!Number.isSafeInteger(input.version) || input.version < 0 || typeof input.enabled !== "boolean") throw new Error("本地媒体处理设置无效");
  mkdirSync(directory, { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  if (fd === undefined) throw new Error("本地媒体处理设置正在被占用，请检查后重试");
  const temporary = join(directory, `state-${randomUUID()}.tmp`);
  let output: number | undefined;
  try {
    const before = mediaControlState();
    if (before.state !== "ready") throw new Error("本地媒体处理设置无法读取，已暂停新本地媒体处理；请检查数据目录");
    if (input.version !== before.version) throw new MediaControlConflict("本地媒体处理状态已在其他窗口修改，请刷新后重试");
    if (input.enabled && !before.runtimeAllowed) throw new MediaControlConflict("启动配置尚未允许本地媒体处理，请先启用 STUDIO_MEDIA_ENABLED 并重启服务");
    const next = { format: 1, version: input.version + 1, enabled: input.enabled, updatedAt: new Date().toISOString(), updatedBy: actor };
    output = openSync(temporary, "wx", 0o600); writeFileSync(output, JSON.stringify(next) + "\n"); fsyncSync(output); closeSync(output); output = undefined;
    renameSync(temporary, filename);
    return mediaControlState();
  } finally {
    try { if (output !== undefined) closeSync(output); } finally {
      try { unlinkSync(temporary); } catch {}
      try { closeSync(fd); } finally { unlinkSync(lock); }
    }
  }
}
