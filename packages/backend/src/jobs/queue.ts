// Job queue on PostgreSQL (pg-boss). Every queue is declared here with the data its jobs carry and its
// retry policy: business code enqueues by name, the worker registers one handler per queue (jobs/*.ts),
// and both sides are checked against JobData, so a payload cannot drift between producer and consumer.
// A module declares its own queues (modules.ts ModuleQueue), typed by the queue in the same way.
import { PgBoss, type SendOptions, type WorkOptions } from "pg-boss";
import { randomUUID } from "node:crypto";
import { claimExecutionLease, releaseExecutionLease } from "./execution-lease.ts";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { logError } from "../lib/log-error.ts";
import { editorialPipelineEnabled, serverModules, type ModuleQueue, type QueueAdmission } from "../modules.ts";
export { shutdownSignal } from "../lib/shutdown.ts";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;
const admittedWorkers = new Map<() => Promise<void>, { queue: string; startedAt: number | null }>();

export interface JobData {
  "content.analyze": { articleId: string; attemptTag?: string };
  "content.extract-body": { articleId: string };
  "events.group": { articleId: string; signalOnly?: boolean };
  "events.digest": { storyId: number };
  "sources.fetch": { sourceId: string; force?: boolean };
  "sources.fetch-x": { key: string; sourceIds: string[] };
  "sources.mp": { sourceId: string; reason?: "schedule" | "manual" };
  "notify.selected": { articleId: string; attempt?: number };
  "publication.republish-source": { sourceId: string };
  "media.prepare": { articleId: string } | { url: string; mode: string };
}
export type QueueName = keyof JobData;

export const QUEUES = {
  analyze: "content.analyze",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  fetchXShard: "sources.fetch-x",
  mpCheck: "sources.mp",
  notifySelected: "notify.selected",
  republishSource: "publication.republish-source",
  prepareMedia: "media.prepare",
} as const satisfies Record<string, QueueName>;

const EDITORIAL_QUEUES = new Set<string>([
  QUEUES.analyze, QUEUES.group, QUEUES.digest, QUEUES.notifySelected, QUEUES.prepareMedia, QUEUES.republishSource,
]);

export type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/** A controlled pause returns an admitted job to waiting without spending a failure retry. */
export class QueueDeferred extends Error {}

/** Queue definitions in one place; created on first use by any process. */
const QUEUE_OPTIONS: Record<QueueName, QueueOptions> = {
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.fetchXShard]: { policy: "short", retryLimit: 0, expireInSeconds: 900 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },
  [QUEUES.prepareMedia]: { policy: "short", retryLimit: 1, retryDelay: 120, expireInSeconds: 600 },
};

const ensured = new Set<string>();

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config.databaseUrl, max: 4, schema: "pgboss", application_name: "aihot-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", logError(err)));
    try {
      await b.start();
      boss = b;
      return b;
    } catch (error) {
      await b.stop({ graceful: false }).catch((cleanup) => console.error("[pg-boss] startup cleanup", logError(cleanup)));
      throw error;
    } finally {
      // A temporary connection error must not leave every caller sharing a rejected promise.
      starting = null;
    }
  })();
  return starting;
}

/** The longest single paid call (a translation batch, 180 s) plus margin; whatever stops the worker (systemd, Docker) waits longer. */
export const STOP_TIMEOUT_MS = 195_000;

/** Callers may shorten, but never extend, the shared shutdown deadline. */
export function stopBoss(options: { timeoutMs: number }): Promise<void>;
export function stopBoss(): Promise<void>;
export async function stopBoss(options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS, stopStarted = performance.now();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STOP_TIMEOUT_MS) throw new Error("队列停止期限无效");
  const waitForDrain = async (pending: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("未能确认队列退出，连接与任务状态已保留")), Math.max(1, timeoutMs - (performance.now() - stopStarted)));
      })]);
    } finally { clearTimeout(timer); }
  };
  shutdownSignal.abort();
  const admittedDrain = Promise.all([...admittedWorkers.keys()].map(stop => stop()));
  if (boss) {
    const draining = boss;
    const started = stopStarted;
    const report = (phase: "start" | "waiting" | "complete") => {
      // Read this process's workers, including scheduled/internal work. Never log payloads or errors:
      // they can contain credentials and reader data. Multiple workers on one queue count together.
      const queues = new Map<string, { queue: string; count: number; oldestMs: number }>();
      const now = Date.now();
      for (const work of draining.getWipData({ includeInternal: true })) {
        if (!work.count) continue;
        const item = queues.get(work.name) ?? { queue: work.name, count: 0, oldestMs: 0 };
        item.count += work.count;
        item.oldestMs = Math.max(item.oldestMs, work.lastJobStartedOn === null ? 0 : Math.max(0, now - work.lastJobStartedOn));
        queues.set(work.name, item);
      }
      for (const work of admittedWorkers.values()) {
        if (work.startedAt === null) continue;
        const item = queues.get(work.queue) ?? { queue: work.queue, count: 0, oldestMs: 0 };
        item.count++;
        item.oldestMs = Math.max(item.oldestMs, Math.max(0, performance.now() - work.startedAt));
        queues.set(work.queue, item);
      }
      const jobs = [...queues.values()].sort((a, b) => a.queue.localeCompare(b.queue));
      console.log(JSON.stringify({ level: "info", msg: "queue drain", phase,
        elapsedMs: Math.round(performance.now() - started), count: jobs.reduce((sum, job) => sum + job.count, 0), jobs }));
    };
    report("start");
    const progress = setInterval(() => report("waiting"), 10_000);
    progress.unref();
    try {
      // Stop ordinary/internal consumers immediately too. Keep their pool open until admitted
      // readers persist their completion; otherwise their successful work cannot be settled.
      await waitForDrain(Promise.all([admittedDrain, draining.stop({ close: false, graceful: true, timeout: timeoutMs })]));
      await waitForDrain(draining.stop());
      report("complete");
    } finally {
      clearInterval(progress);
    }
  } else await waitForDrain(admittedDrain);
  boss = null;
  starting = null;
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name as QueueName] ?? {}): Promise<void> {
  if (ensured.has(name)) return;
  const b = await getBoss();
  const existing = await b.getQueue(name);
  if (!existing) await b.createQueue(name, options);
  ensured.add(name);
}

function queueDb(tx: Db) {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}, tx?: Db): Promise<string | null> {
  if (!editorialPipelineEnabled() && EDITORIAL_QUEUES.has(name)) return null;
  await ensureQueue(name);
  const b = await getBoss();
  return b.send(name, data, tx ? { ...options, db: queueDb(tx) } : options);
}

/** Enqueues a job on a module's queue. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueueOn<T extends object>(queue: ModuleQueue<T>, data: T, options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(queue.name, queue.options);
  const b = await getBoss();
  return b.send(queue.name, data, tx ? { ...options, db: queueDb(tx) } : options);
}

/** A receipt release also wakes jobs (e.g. grouping/embeddings) that exhausted their queue retries.
 * The release must follow the failed attempt's start: it may arrive while that attempt is finishing,
 * but cannot keep reviving attempts started after it.
 * Reading the durable audit also recovers a crash between the release and this sweep.
 */
export async function retryReleasedReceiptJobs(): Promise<number> {
  const b = await getBoss();
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; name: string }[]>`
      SELECT j.id, j.name FROM pgboss.job j
      WHERE j.state = 'failed'
        AND (${editorialPipelineEnabled()} OR j.name <> ALL(${[...EDITORIAL_QUEUES]}::text[]))
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'receipt.release'
                    AND a.subject = 'receipt:' || (j.output->>'receiptId') AND a.created_at > j.started_on)
      ORDER BY j.completed_on LIMIT 200 FOR UPDATE OF j SKIP LOCKED`;
    for (const job of jobs) await b.retry(job.name, job.id, { db: queueDb(tx) });
    return jobs.length;
  });
}

/** The worker's handler for one queue (jobs/*.ts), called with each job's data. */
export async function work<Q extends QueueName>(boss: PgBoss, name: Q, options: WorkOptions, handler: (data: JobData[Q]) => Promise<unknown>, admission?: QueueAdmission): Promise<void> {
  await ensureQueue(name);
  if (admission) {
    const queue: ModuleQueue<JobData[Q]> = { name, options: QUEUE_OPTIONS[name], worker: options, admission,
      run: async jobs => jobs[0] ? handler(jobs[0]) : undefined };
    startAdmittedQueue(boss, queue);
    return;
  }
  await boss.work<JobData[Q]>(name, options, async ([job]) => (job ? handler(job.data) : undefined));
}

/** The worker's handlers for the site's modules' queues. */
export async function workModuleQueues(boss: PgBoss): Promise<() => Promise<void>> {
  const stops: Array<() => Promise<void>> = [];
  const stop = async () => { await Promise.all(stops.map(stop => stop())); };
  try {
    for (const queue of serverModules().flatMap((m) => m.queues ?? [])) {
      await ensureQueue(queue.name, queue.options);
      if (queue.admission) {
        stops.push(startAdmittedQueue(boss, queue));
        continue;
      }
      const id = await boss.work(queue.name, { ...queue.worker, perJobResults: true }, async (jobs) => {
        const output = await queue.run(jobs.map(job => job.data) as never[]);
        return jobs.map(job => ({ id: job.id, status: "completed" as const, output }));
      });
      stops.push(() => boss.offWork(queue.name, { id, wait: true }));
    }
  } catch (error) { await stop(); throw error; }
  return stop;
}

/** pg-boss has no public pre-claim hook. Reuse its fetch/complete/fail, leaving paused jobs durable. */
function startAdmittedQueue(boss: PgBoss, queue: ModuleQueue): () => Promise<void> {
  if ((queue.worker.localConcurrency ?? 1) !== 1 || (queue.worker.batchSize ?? 1) !== 1
    || queue.options.heartbeatSeconds !== undefined
    || Object.keys(queue.worker).some(key => !["localConcurrency", "batchSize", "pollingIntervalSeconds", "groupConcurrency"].includes(key))
    || !Number.isFinite(queue.worker.pollingIntervalSeconds ?? 2) || (queue.worker.pollingIntervalSeconds ?? 2) < 0.5) {
    throw new Error("受控队列仅支持单任务、单条批次及声明的轮询和分组并发选项");
  }
  const gate = queue.admission!();
  const activity: { queue: string; startedAt: number | null } = { queue: queue.name, startedAt: null };
  let stopping = false, wake: (() => void) | undefined;
  const interval = (queue.worker.pollingIntervalSeconds ?? 2) * 1000;
  const allowed = async (db?: Db) => {
    try {
      if (stopping) return false;
      const permitted = await gate.canStart(db);
      return !stopping && permitted;
    } catch { return false; }
  };
  const admissionChanged = new Error("QUEUE_ADMISSION_CHANGED");
  let lease: { group: string; token: string } | undefined;
  const release = async () => {
    if (!lease) return;
    await releaseExecutionLease(lease.group, lease.token);
    lease = undefined;
  };
  const running = (async () => {
    while (!stopping) {
      try {
        // A failed release retains ownership until a later attempt or bounded expiry.
        // A dropped DB session must not release a running browser/ASR execution slot.
        await release();
        if (await allowed()) {
          const token = randomUUID();
          const jobs = await sql.begin(async tx => {
            if (queue.executionGroup) {
              // Grouped work must enforce its own deadline (queue expiry does not cancel it).
              // Keep the durable slot beyond that bound, including shutdown/process failure.
              const seconds = Math.max(queue.options.expireInSeconds ?? 600, 600) + Math.ceil(STOP_TIMEOUT_MS / 1000);
              const claim = await claimExecutionLease(queue.executionGroup, token, seconds, tx);
              if (!claim) return [];
            }
            const claimed = await boss.fetch(queue.name, { batchSize: 1, groupConcurrency: queue.worker.groupConcurrency, db: queueDb(tx) });
            // The monitor may change while the database claim is in flight. Roll it back rather
            // than hold an active job through pressure or consume one of its failure retries.
            if (!await allowed(tx)) throw admissionChanged;
            if (!claimed.length && queue.executionGroup) await releaseExecutionLease(queue.executionGroup, token, tx);
            return claimed;
          }).catch(error => { if (error === admissionChanged) return []; throw error; });
          const [job] = jobs;
          if (job) {
            if (queue.executionGroup) lease = { group: queue.executionGroup, token };
            activity.startedAt = performance.now();
            try {
              const result = await queue.run([job.data] as never[]);
              await boss.complete(queue.name, job.id, result && typeof result === "object" ? result : { result });
            } catch (error) {
              if (error instanceof QueueDeferred) {
                // Adapt pg-boss 12.34's internal restoreJobs shape here in its engine Adapter.
                // Public cancel/resume leaves started_on set, which spends a retry on re-fetch.
                // Reset only this active claim; retain its id, payload and prior failure count.
                await sql`UPDATE pgboss.job SET state = 'created', started_on = NULL, heartbeat_on = NULL
                  WHERE name = ${queue.name} AND id = ${job.id} AND state = 'active'`;
              } else await boss.fail(queue.name, job.id, { error: logError(error) });
            }
            finally { activity.startedAt = null; }
          }
        }
      } catch (error) { console.error("[module-queue]", logError(error)); }
      finally {
        try { await release(); }
        catch (error) { console.error("[module-queue] release deferred", logError(error)); }
      }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, interval);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  })();
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    stopping = true; wake?.();
    try { await running; } finally { gate.stop(); admittedWorkers.delete(stop); }
  })();
  admittedWorkers.set(stop, activity);
  return stop;
}

// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.

export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = await fn();
    const detail = result && typeof result === "object" ? result : { result };
    await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json(detail as never)} WHERE id = ${row!.id}`;
    return result;
  } catch (error) {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 4000)} WHERE id = ${row!.id}`;
    throw error;
  }
}
