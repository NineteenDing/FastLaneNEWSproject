import { DEFAULT_UA, type GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import { readNativeRsshub } from "./rsshub-native.ts";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { loadRsshubBuildManifest, nativeRsshubDirectory, verifyRsshubBuild } from "./rsshub-build.ts";

/** Separate operator-only integration, never enabled by an arbitrary source URL. */
export function rsshubOrigin(): string | null {
  if (process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY) {
    if (process.env.STUDIO_RSSHUB_BASE_URL) throw new UnsupportedConfig("RSSHub原生目录与外部服务地址不能同时配置");
    // An internal identity only: native jobs do not make HTTP requests to this hostname.
    return "http://rsshub.local";
  }
  const value = process.env.STUDIO_RSSHUB_BASE_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new UnsupportedConfig("RSSHub地址须为本机127.0.0.1或[::1]的HTTP(S)服务，不含路径、参数或凭据"); }
}

export function rsshubState(): "not_configured" | "configured" | "invalid" {
  try { return rsshubOrigin() ? "configured" : "not_configured"; }
  catch { return "invalid"; }
}

/** Fixed literal loopback origin, no redirects, one deadline and a bounded body. */
export async function readRsshub(url: string): Promise<GuardedResponse> {
  const origin = rsshubOrigin();
  if (!origin || new URL(url).origin !== origin) throw new UnsupportedConfig("RSSHub运行服务尚未配置或目标不匹配");
  if (process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash || parsed.searchParams.size !== 1 || !parsed.searchParams.has("limit")) throw new UnsupportedConfig("RSSHub原生请求参数无效");
    const folder = await nativeRsshubDirectory(path.resolve(import.meta.dirname, "../../..", process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY));
    if (await lstat(folder + ".installing").then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))
      throw new Error("RSSHub依赖正在安装或安装尚未完成，请检查独立版本目录");
    await verifyRsshubBuild(folder,
      await loadRsshubBuildManifest(process.env.STUDIO_RSSHUB_BUILD_MANIFEST));
    const response = await readNativeRsshub(parsed.pathname, Number(parsed.searchParams.get("limit")), { runtimeDirectory: process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY });
    if (response.status !== 200) throw new Error("RSSHub读取失败，请检查服务及路由");
    return response;
  }
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": DEFAULT_UA, accept: "application/rss+xml, application/atom+xml, application/xml" } });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("RSSHub读取失败，请检查服务及路由"); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error("RSSHub响应超过4MB，未接受本次结果");
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return { status: 200, url, body, headers: response.headers as unknown as Headers, text: () => body.toString("utf8") };
}
