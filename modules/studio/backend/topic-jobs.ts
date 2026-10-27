import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "./collection-admission.ts";
import { createHostResourceMonitor } from "./host-resources.ts";
import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createDatabaseResourceMonitor } from "./database-resources.ts";
import { freezeNextTopicBatch, nextTopicBatchStart } from "./topic-batches.ts";

/** One window per job. The durable batch cursor, not the cron time, drives catch-up. */
export function createTopicFreezeQueue(host = createHostResourceMonitor(), disk = createDiskResourceMonitor(), database = createDatabaseResourceMonitor()) {
  const admit = createCollectionAdmission({ host, disk, database, heavy: true, enabled: () => true });
  let gate: ReturnType<typeof admit> | undefined;
  return defineQueue<Record<string, never>>({
    name: "studio.topic.freeze",
    options: { policy: "short", retryLimit: 3, retryDelay: 60, expireInSeconds: 600 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
    admission: () => { gate = admit(); return gate; },
    async run() {
      const result=await freezeNextTopicBatch(() => gate?.canStart() ?? false);
      if('batch' in result && result.batch && await (await import('./model-operations.ts')).modelWorkAllowed())
        await (await import('./topic-directions.ts')).submitTopicGeneration(result.batch.id,'system:topic-cutoff');
      return result;
    },
  });
}

export const topicFreezeQueue = createTopicFreezeQueue();

export async function scheduleTopicBatches() {
  if (!await nextTopicBatchStart()) return { queued: false };
  const id = await enqueueOn(topicFreezeQueue, {}, { singletonKey: "topic-cutoff", group: { id: "topic-cutoff" } });
  return { queued: !!id };
}
