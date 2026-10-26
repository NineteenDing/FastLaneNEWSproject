import { createHostResourceMonitor } from "./host-resources.ts";
import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createDatabaseResourceMonitor } from "./database-resources.ts";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";

/** Worker-owned monitors. Callers share their decisions, not private readings or thresholds. */
export function createCollectionAdmission(options: {
  host?: ReturnType<typeof createHostResourceMonitor>;
  disk?: ReturnType<typeof createDiskResourceMonitor>;
  database?: ReturnType<typeof createDatabaseResourceMonitor>;
  enabled?: () => boolean;
  /** Media preparation uses the disk's stricter heavy-task threshold. */
  heavy?: boolean;
} = {}) {
  const host = options.host ?? createHostResourceMonitor(), disk = options.disk ?? createDiskResourceMonitor();
  const database = options.database ?? createDatabaseResourceMonitor();
  const enabled = options.enabled ?? collectionEnabled;
  let owned = false;
  return () => {
    if (owned) throw new Error("新闻采集监测已被活动消费者使用");
    const stops: Array<() => void> = [];
    owned = true;
    try { stops.push(host.start()); stops.push(disk.start()); stops.push(database.start()); }
    catch (error) { for (const stop of stops) stop(); owned = false; throw error; }
    let stopped = false;
    return {
      canStart: () => !stopped && enabled() && host.status().state === "ready"
        && (options.heavy ? disk.status().heavyTaskAllowed : disk.status().ingestionAllowed) && database.status().ingestionAllowed,
      stop() {
        if (stopped) return;
        stopped = true;
        for (const stop of stops) stop();
        owned = false;
      },
    };
  };
}
