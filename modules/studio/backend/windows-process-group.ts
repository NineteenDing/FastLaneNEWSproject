import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import { readWindowsProcessGroupMessage, type WindowsProcessGroupResult, type WindowsProcessGroupStatus } from "./windows-process-group-protocol.ts";
export type { WindowsProcessGroupStatus } from "./windows-process-group-protocol.ts";

/** Internal operator interface: starts new owned processes only; never attaches to existing PIDs. */
export async function runWindowsProcessGroup(options: {
  executable: string; args: string[]; cwd: string; cpuPercent: number; memoryLimitBytes: number;
  signal?: AbortSignal;
  onStatus?: (status: WindowsProcessGroupStatus) => void;
}): Promise<WindowsProcessGroupResult> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("资源组仅支持Windows x64，请先验证目标环境");
  if (!Number.isInteger(options.cpuPercent) || options.cpuPercent < 1 || options.cpuPercent > 75
    || !Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 64 * 1024 ** 2 || options.memoryLimitBytes > 6 * 1024 ** 3)
    throw new Error("资源额度无效：CPU须为1至75整数百分比，整组提交内存64MiB至6GiB");
  options.signal?.throwIfAborted();
  const configuration = JSON.stringify({ executable: options.executable, args: options.args, cwd: options.cwd,
    cpuPercent: options.cpuPercent, memoryLimitBytes: options.memoryLimitBytes });
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "windows-process-group.ps1")],
      { windowsHide: true, env: localProcessEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    let result: WindowsProcessGroupResult | undefined;
    let failed = false;
    let started = false;
    let forced = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const forceStop = () => { forced = true; child.kill(); }; // Only the owned controller; closing its Job handle kills the group.
    const startupTimer = setTimeout(forceStop, 30_000);
    const requestStop = () => { child.stdin.end(); stopTimer ??= setTimeout(forceStop, 5000); };
    const abort = options.signal ? addAbortListener(options.signal, requestStop) : undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        if (failed) return;
        const raw: unknown = JSON.parse(line);
        const message = readWindowsProcessGroupMessage(raw);
        if (!message) throw new Error("Invalid resource group message");
        if (message.type === "status") {
          if (message.cpuPercent !== options.cpuPercent || message.memoryLimitBytes !== options.memoryLimitBytes)
            throw new Error("Resource group configuration mismatch");
          clearTimeout(startupTimer);
          options.onStatus?.(message);
          if (!started && !options.signal?.aborted) { started = true; child.stdin.write("start\n"); }
        }
        else if (message.type === "result" && (started || options.signal?.aborted)) { result = message; requestStop(); }
        else throw new Error("Resource group failed");
      } catch { failed = true; requestStop(); }
    });
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("Windows资源组无法启动")));
    child.once("close", code => {
      clearTimeout(startupTimer); clearTimeout(stopTimer);
      abort?.[Symbol.dispose]();
      lines.close();
      if (forced || (options.signal?.aborted && !result)) reject(new Error("无法确认资源组退出，请核对项目任务状态；未回退无约束执行"));
      else if (code !== 0 || failed || !result) reject(new Error("Windows资源组运行失败，未使用无约束模式重试"));
      else if (options.signal?.aborted) reject(options.signal.reason);
      else resolve({ exitCode: result.exitCode, peakMemoryBytes: result.peakMemoryBytes });
    });
    child.stdin.write(configuration + "\n");
  });
}
