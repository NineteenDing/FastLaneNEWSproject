/** Private loopback HTTP contract; never contains tokens, local paths or process IDs. */
import type { RuntimeLogStatus } from "../modules/studio/contracts.ts";
export type LocalResourceStatus = { state: "unprotected" | "unavailable" } | {
  state: "protected"; scope: "supervisor_api_web_descendants" | "supervisor_api_web_worker_descendants"; cpuPercent: number; memoryLimitBytes: number;
  activeProcesses: number; excluded: ["postgres", "launcher", "job_controller"];
};
export type LocalRuntimeStatus = {
  ok: boolean; state: "running" | "starting"; web: string; api: string;
  worker: "disabled" | "starting" | "running";
  externalActions: "disabled" | "models_allowed" | "collection_allowed" | "models_and_collection_allowed";
  mediaProcessingAllowed?: boolean; resources: LocalResourceStatus; logs?: RuntimeLogStatus;
};
export type LocalControlResponse = LocalRuntimeStatus | { ok: true; state: "stopped" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function localOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.origin === value && url.protocol === "http:" && url.hostname === "127.0.0.1"; }
  catch { return false; }
}
function resourceStatus(value: unknown): LocalResourceStatus | null {
  // Pre-Job local supervisors are readable as unprotected during a controlled upgrade.
  if (value === undefined) return { state: "unprotected" };
  const data = record(value);
  if (!data) return null;
  if (data.state === "unprotected" || data.state === "unavailable") return { state: data.state };
  if (data.state !== "protected" || (data.scope !== "supervisor_api_web_descendants" && data.scope !== "supervisor_api_web_worker_descendants")
    || !integer(data.cpuPercent, 1, 75) || !integer(data.memoryLimitBytes, 64 * 1024 ** 2, 6 * 1024 ** 3)
    || !integer(data.activeProcesses, 0, 0xffffffff) || !Array.isArray(data.excluded) || data.excluded.length !== 3
    || !data.excluded.every((value, index) => value === ["postgres", "launcher", "job_controller"][index])) return null;
  return { state: "protected", scope: data.scope, cpuPercent: data.cpuPercent,
    memoryLimitBytes: data.memoryLimitBytes, activeProcesses: data.activeProcesses, excluded: ["postgres", "launcher", "job_controller"] };
}
export function readLocalControlResponse(value: unknown): LocalControlResponse | null {
  const data = record(value);
  if (!data) return null;
  if (data.state === "stopped" && data.ok === true) return { ok: true, state: "stopped" };
  if ((data.state !== "running" && data.state !== "starting") || data.ok !== (data.state === "running")
    || !localOrigin(data.web) || !localOrigin(data.api) || !["disabled", "starting", "running"].includes(data.worker as string)
    || (data.state === "running" && data.worker === "starting")
    || !["disabled", "models_allowed", "collection_allowed", "models_and_collection_allowed"].includes(data.externalActions as string)) return null;
  if (data.mediaProcessingAllowed !== undefined && (typeof data.mediaProcessingAllowed !== "boolean"
    || data.mediaProcessingAllowed && !["collection_allowed", "models_and_collection_allowed"].includes(data.externalActions as string))) return null;
  const resources = resourceStatus(data.resources);
  if (!resources) return null;
  let logs: RuntimeLogStatus | undefined;
  if (data.logs !== undefined) {
    const raw = record(data.logs);
    if (!raw || (raw.scope !== "api_web" && raw.scope !== "api_web_worker") || (raw.state !== "normal" && raw.state !== "limited" && raw.state !== "unavailable")
      || (raw.storedBytes !== null && !integer(raw.storedBytes, 0, Number.MAX_SAFE_INTEGER))
      || !integer(raw.limitBytes, 8192, 256 * 1024 ** 2) || !integer(raw.droppedRecords, 0, Number.MAX_SAFE_INTEGER)) return null;
    logs = { scope: raw.scope, state: raw.state, storedBytes: raw.storedBytes,
      limitBytes: raw.limitBytes, droppedRecords: raw.droppedRecords };
  }
  return { ok: data.ok, state: data.state, web: data.web, api: data.api, worker: data.worker as LocalRuntimeStatus["worker"],
    externalActions: data.externalActions as LocalRuntimeStatus["externalActions"],
    ...(typeof data.mediaProcessingAllowed === "boolean" ? { mediaProcessingAllowed: data.mediaProcessingAllowed } : {}), resources, ...(logs ? { logs } : {}) };
}
