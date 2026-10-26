import type { ApplicationResources } from "../contracts.ts";

/** Both the Windows observer and authenticated operator control use the same whitelist. */
export function readApplicationResources(value: unknown): ApplicationResources | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.state === "unavailable" && data.ok === false) return { ok: false, state: "unavailable" };
  const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
  if (data.ok !== true || data.state !== "measured" || data.scope !== "runtime_and_database_cluster" || data.enforcement !== "runtime_job_only"
    || !integer(data.databaseMainSharedBytes, 1) || !integer(data.memoryEstimateBytes, 1)
    || !Array.isArray(data.components) || data.components.length !== 4 || !Array.isArray(data.unmeasured)
    || data.unmeasured.length !== 3 || !data.unmeasured.every((item, index) => item ===
      ["other_shared_mappings", "database_dynamic_shared_memory", "nginx_and_service_host"][index])) return null;
  const roles = ["runtime", "launcher", "job_controller", "database"] as const;
  const components: Extract<ApplicationResources, { state: "measured" }>["components"] = [];
  for (const [index, raw] of data.components.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (item.role !== roles[index] || !integer(item.processes, 1) || item.processes > 8192
      || !integer(item.privateBytes) || !integer(item.cpuTimeMs)) return null;
    components.push({ role: roles[index]!, processes: item.processes, privateBytes: item.privateBytes, cpuTimeMs: item.cpuTimeMs });
  }
  if (components.reduce((sum, item) => sum + item.privateBytes, data.databaseMainSharedBytes) !== data.memoryEstimateBytes) return null;
  return { ok: true, state: "measured", scope: "runtime_and_database_cluster", enforcement: "runtime_job_only", components,
    databaseMainSharedBytes: data.databaseMainSharedBytes, memoryEstimateBytes: data.memoryEstimateBytes,
    unmeasured: ["other_shared_mappings", "database_dynamic_shared_memory", "nginx_and_service_host"] };
}
