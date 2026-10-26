import { createStorageWorkspaces } from "./storage-workspaces.ts";
import type { DiskResourceStatus } from "../contracts.ts";
import { createResourceSampler } from "./resource-sampler.ts";
import { diskBudget } from "./storage-capacity.ts";

function unknownStatus(state: "warming" | "unavailable" = "warming"): DiskResourceStatus {
  return { scope: "data_volume", state, availableBytes: null, reservedBytes: null,
    unreservedBytes: null, sampleAgeMs: null, ingestionAllowed: false, heavyTaskAllowed: false };
}

/** Uses the shared persistent workspace ledger; this monitor does not reserve space or delete content. */
export function createDiskResourceMonitor(options: { availableBytes?: () => Promise<number>; now?: () => number } = {}) {
  const workspaces = createStorageWorkspaces(options);
  const now = options.now ?? (() => Math.floor(performance.now()));
  let status = unknownStatus(), ingestionBlocked = true, heavyBlocked = true;
  let sampledAt: number | undefined;
  function invalidate() {
    ingestionBlocked = heavyBlocked = true; sampledAt = undefined;
    status = unknownStatus("unavailable");
  }
  function view(): DiskResourceStatus {
    if (sampledAt === undefined) return { ...status };
    try {
      const age = now() - sampledAt;
      if (!Number.isSafeInteger(age) || age < 0 || age > 15_000) return unknownStatus("unavailable");
      return { ...status, sampleAgeMs: age };
    } catch { return unknownStatus("unavailable"); }
  }
  const sampling = createResourceSampler({ intervalMs: 5000, invalidate,
    async sample(current) {
      if (!current()) return;
      let at: number, storage;
      try {
        at = now();
        if (!Number.isSafeInteger(at) || at < 0) throw new Error();
        if (sampledAt !== undefined && (at < sampledAt || at - sampledAt > 15_000)) invalidate();
        storage = await workspaces.status();
        const age = now() - at;
        if (!Number.isSafeInteger(age) || age < 0 || age > 15_000
          || !Number.isSafeInteger(storage.reservedBytes) || storage.reservedBytes < 0) throw new Error();
      } catch { if (current()) invalidate(); return; }
      if (!current()) return;
      const free = Math.max(0, storage.availableBytes - storage.reservedBytes);
      if (free >= diskBudget.recoveryBytes) ingestionBlocked = heavyBlocked = false;
      else {
        if (free < diskBudget.heavyPauseBytes) heavyBlocked = true;
        if (free < diskBudget.keepFreeBytes) ingestionBlocked = true;
      }
      status = { scope: "data_volume", state: free < diskBudget.keepFreeBytes ? "protected" : ingestionBlocked ? "recovering"
        : free < diskBudget.heavyPauseBytes ? "limited" : heavyBlocked ? "recovering" : free < diskBudget.warningBytes ? "warning" : "normal",
        availableBytes: storage.availableBytes, reservedBytes: storage.reservedBytes, unreservedBytes: free,
        sampleAgeMs: 0, ingestionAllowed: !ingestionBlocked, heavyTaskAllowed: !heavyBlocked };
      sampledAt = at;
    },
  });
  return { ...sampling, status: view };
}
