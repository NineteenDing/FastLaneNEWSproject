// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { dajialaConfigured } from "../providers/dajiala.ts";
import { collectSource, collectXShard } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { QUEUES, work } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";
import { serverModules } from "../modules.ts";
import { sharedQueueAdmission } from "./admission.ts";

export async function registerSourceJobs(boss: PgBoss) {
  const admission = sharedQueueAdmission(serverModules().flatMap(module => module.sourceCollectionAdmission ?? []));
  await work(boss, QUEUES.fetchSource, { localConcurrency: admission ? 1 : 8, pollingIntervalSeconds: 2 },
    ({ sourceId, force }) => collectSource(sourceId, { force }), admission);
  // One search per shard of X accounts; every SocialData caller shares its per-minute budget.
  await work(boss, QUEUES.fetchXShard, { localConcurrency: admission ? 1 : 2, pollingIntervalSeconds: 2 },
    ({ key, sourceIds }) => collectXShard(key, sourceIds), admission);
  // WeChat accounts through Dajiala, only when configured. Resource-gated workers use one account
  // at a time; the ungated engine retains its original two-account concurrency.
  if (dajialaConfigured()) await work(boss, QUEUES.mpCheck, { localConcurrency: admission ? 1 : 2, pollingIntervalSeconds: 2 },
    ({ sourceId, reason }) => checkMpAccount(sourceId, reason ?? "schedule"), admission);
  await registerExtractionJobs(boss, admission);
}
