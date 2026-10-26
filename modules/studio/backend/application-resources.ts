import { spawn } from "node:child_process";
import path from "node:path";
import postgres from "postgres";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import type { ApplicationResources } from "../contracts.ts";
import { readApplicationResources } from "./application-resources-protocol.ts";

/** One operator-requested snapshot. Does not attach, stop or change the database process. */
export async function inspectApplicationResources(databaseUrl: string, ownership: { file: string; id: string }): Promise<ApplicationResources> {
  const unavailable: ApplicationResources = { ok: false, state: "unavailable" };
  if (process.platform !== "win32") return unavailable;
  const db = postgres(databaseUrl, { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 3000 } });
  try {
    return await db.begin(async tx => {
      const [database] = await tx<{ backendPid: number; startedAtMs: number; sharedBytes: number }[]>`
        SELECT pg_backend_pid() AS "backendPid", extract(epoch FROM pg_postmaster_start_time())::float8 * 1000 AS "startedAtMs",
          pg_size_bytes(current_setting('shared_memory_size'))::float8 AS "sharedBytes"`;
      if (!database || !Number.isSafeInteger(database.backendPid) || database.backendPid < 1
        || !Number.isFinite(database.startedAtMs) || !Number.isSafeInteger(database.sharedBytes) || database.sharedBytes <= 0) return unavailable;
      const raw = await new Promise<string>((resolve, reject) => {
        const child = spawn(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "windows-process-usage.ps1")],
          { windowsHide: true, env: localProcessEnvironment(), stdio: ["pipe", "pipe", "ignore"], signal: AbortSignal.timeout(6000) });
        let output = "", oversized = false;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
          if (oversized) return;
          output += chunk;
          if (Buffer.byteLength(output) > 16_384) { oversized = true; child.kill(); }
        });
        child.stdin.on("error", () => {});
        child.once("error", () => reject(new Error("资源观察器不可用")));
        child.once("close", code => code === 0 && !oversized ? resolve(output) : reject(new Error("资源观察器不可用")));
        // Credentials never enter arguments, the helper environment or its input.
        child.stdin.end(JSON.stringify({ rootPid: process.pid, executable: process.execPath,
          backendPid: database.backendPid, databaseStartedAtMs: database.startedAtMs, ownershipFile: ownership.file, ownershipId: ownership.id }) + "\n");
      });
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("components" in value) || !Array.isArray(value.components)) return unavailable;
      const components = value.components;
      const candidate = readApplicationResources({ ok: true, state: "measured", scope: "runtime_and_database_cluster",
        enforcement: "runtime_job_only", components, databaseMainSharedBytes: database.sharedBytes,
        memoryEstimateBytes: components.reduce((sum: number, item: { privateBytes?: unknown }) =>
          sum + (typeof item?.privateBytes === "number" ? item.privateBytes : NaN), database.sharedBytes),
        unmeasured: ["other_shared_mappings", "database_dynamic_shared_memory", "nginx_and_service_host"] });
      return candidate ?? unavailable;
    });
  } catch { return unavailable; }
  finally { try { await db.end({ timeout: 1 }); } catch { return unavailable; } }
}
