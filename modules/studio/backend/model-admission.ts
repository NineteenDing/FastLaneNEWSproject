import { config } from "@aihot/backend/config";
import type { AsyncQueueAdmission } from "@aihot/backend/modules";
import { createCollectionAdmission } from "./collection-admission.ts";
import { modelWorkAllowed } from "./model-operations.ts";

/** Resource checks stay synchronous; private persistent permission is rechecked in the claim transaction. */
export function createModelAdmission(options: Parameters<typeof createCollectionAdmission>[0] = {}): AsyncQueueAdmission {
  const resources = createCollectionAdmission({ ...options, heavy: true, enabled: () => config.modelCallsEnabled });
  return () => {
    const gate = resources();
    return { canStart: async db => gate.canStart() && await modelWorkAllowed(db) && gate.canStart(), stop: gate.stop };
  };
}
