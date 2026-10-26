import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import type { GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { createRsshubOutbound } from "./rsshub-outbound.ts";
import { isRsshubRoute } from "./rsshub-routes.ts";
import { readChildMessage, type RsshubParentMessage } from "./rsshub-native-protocol.ts";
import { nativeRsshubDirectory } from "./rsshub-build.ts";

const root = path.resolve(import.meta.dirname, "../../..");
let active = false;

/** Operator-owned runtime only. A source can choose a route, never executable paths or env. */
export async function readNativeRsshub(route: string, limit: number, options: { runtimeDirectory?: string; signal?: AbortSignal } = {}): Promise<GuardedResponse> {
  if (!isRsshubRoute(route) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("RSSHub路由或条数无效");
  const folder = await nativeRsshubDirectory(options.runtimeDirectory ?? "runtime/rsshub");
  const entry = await realpath(path.join(folder, "dist/index.mjs"));
  if (!entry.startsWith(folder + path.sep)) throw new Error("RSSHub入口不能指向运行目录之外");
  if (await access(path.join(folder, ".env")).then(() => true, () => false)) throw new Error("RSSHub运行目录不能包含环境凭据文件");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(18_000)]) : AbortSignal.timeout(18_000);
  signal.throwIfAborted();
  if (active) throw new Error("已有RSSHub采集任务正在运行，请等待队列重试");
  active = true;
  try {
    const outbound = createRsshubOutbound({ signal });
    const env = { ...localProcessEnvironment(), NODE_ENV: "production", LISTEN_INADDR_ANY: "false", ENABLE_CLUSTER: "false",
      NO_LOGFILES: "true", LOGGER_LEVEL: "error", MEMORY_MAX: "32", REQUEST_RETRY: "0", DISABLE_NSFW: "true" };
    return await new Promise<GuardedResponse>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=384", "--permission",
        ...[folder, import.meta.dirname, path.join(root, "package.json"), path.join(root, "modules/studio/package.json")].map(folder => "--allow-fs-read=" + folder),
        path.join(import.meta.dirname, "rsshub-native-child.ts"), entry, route, String(limit)],
        { cwd: folder, env, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
      let result: GuardedResponse | undefined;
      let failure: unknown;
      let ending = false;
      let upstreamFailed = false;
      let pendingRequests = 0;
      const send = (message: RsshubParentMessage) => {
        try { if (child.connected) child.send(message, () => {}); }
        catch { finish(new Error("RSSHub独立进程通信中断")); }
      };
      const finish = (error?: unknown) => {
        if (ending) return;
        ending = true; failure = error;
        outbound.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      };
      const subscription = addAbortListener(signal, () => finish(signal.reason));
      child.on("message", async (raw: unknown) => {
        if (ending) return;
        const message = readChildMessage(raw);
        if (!message) { finish(new Error("RSSHub结果无效或超过限制")); return; }
        if (message.type === "fetch") {
          pendingRequests++;
          try {
            const body = message.body === undefined ? undefined : Uint8Array.from(Buffer.from(message.body, "base64"));
            const response = await outbound.fetch(message.url, { method: message.method,
              headers: message.headers, body, redirect: message.redirect });
            send({ type: "response", id: message.id, status: response.status, url: response.url, redirected: response.redirected,
              headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()).toString("base64") });
          } catch { upstreamFailed = true; send({ type: "response", id: message.id, error: "RSSHub受控上游请求失败" }); }
          finally { pendingRequests--; }
        } else if (message.type === "result") {
          if (upstreamFailed || pendingRequests > 0) { finish(new Error("RSSHub独立采集失败：上游请求未完整完成，不能将备用正文视作完整采集")); return; }
          try {
            const body = Buffer.from(message.body, "base64");
            if (body.length > 4 * 1024 * 1024) throw new Error("Result too large");
            result = { status: message.status, url: `http://rsshub.local${route}?limit=${limit}`, headers: new Headers(message.headers), body, text: () => body.toString("utf8") };
            finish();
          } catch { finish(new Error("RSSHub结果无效或超过4MiB")); }
        } else if (message.type === "error") finish(new Error(upstreamFailed || pendingRequests > 0
          ? "RSSHub独立采集失败：上游请求未完整完成，不能将备用正文视作完整采集"
          : "RSSHub独立采集失败，请检查来源和运行配置"));
      });
      child.once("error", () => { subscription[Symbol.dispose](); outbound.close(); reject(new Error("RSSHub独立进程未能启动")); });
      child.once("exit", () => {
        subscription[Symbol.dispose](); outbound.close();
        if (failure) reject(failure);
        else if (result) resolve(result);
        else reject(new Error("RSSHub独立进程在完成前退出"));
      });
    });
  } finally { active = false; }
}
