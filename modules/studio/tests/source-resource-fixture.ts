import assert from "node:assert/strict";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createDatabaseResourceMonitor } from "../backend/database-resources.ts";
import { createCollectionAdmission } from "../backend/collection-admission.ts";
import { createStudioServer } from "../server.ts";

type ResourceCapacity = { memoryBytes: number; databaseBytes: number; diskBytes: number };
function monitors(capacity: ResourceCapacity) {
  let now = 0;
  const host = createHostResourceMonitor({ now: () => now, read: () => {
    now += 5000; return { availableMemoryBytes: capacity.memoryBytes, totalMemoryBytes: 8 * 1024 ** 3,
      cpus: [{ idle: now, total: now * 2 }] };
  } });
  const disk = createDiskResourceMonitor({ availableBytes: async () => capacity.diskBytes });
  const database = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes: capacity.databaseBytes, walBytes: 0, temporaryBytes: 0 }) });
  return { host, disk, database };
}

/** Actual resource modules and private API; only OS/clock/capacity readings are test inputs. */
export async function sourceResourceFixture(extra: Parameters<typeof createStudioServer>[0] = {}) {
  const capacity = { memoryBytes: 4 * 1024 ** 3, databaseBytes: 1024 ** 3, diskBytes: 20 * 1024 ** 3 };
  const { host, disk, database } = monitors(capacity);
  const admission = createCollectionAdmission({ host, disk, database });
  // API and worker share OS readings, each owns its monitor lifecycle and recovery state.
  const api = monitors(capacity);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, http: createStudioServer({ ...api, ...extra }).http, sourceCollectionAdmission: admission } : module));
  const app = await buildApp();
  config.adminPassword = "source-resource-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ username: config.adminUsername ?? "admin", password: "source-resource-password" }).toString() });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  assert.equal(me.statusCode, 200);
  const headers = { cookie, "x-csrf-token": me.json().csrf as string };
  return { app, headers, capacity, host, disk, database, admission, api, async warm() {
    for (let n = 0; n < 14; n++) { host.sample(); api.host.sample(); }
    await disk.sample(); await database.sample();
    await api.disk.sample(); await api.database.sample();
  } };
}
