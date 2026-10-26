import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { ensureQueue, enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { historyIndexPolicy, indexHistoryMaterial } from "./history-index.ts";
import { createCollectionAdmission } from "./collection-admission.ts";
import { createHostResourceMonitor } from "./host-resources.ts";
import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createDatabaseResourceMonitor } from "./database-resources.ts";
import type { HistoryIndexStatus } from "../contracts.ts";
import { backgroundWorkHasPriority } from "./background-priority.ts";

type Row = { id: string; policy: string; state: "queued" | "running" | "completed" | "failed"; phase: "news" | "creator" | "done";
  news_upper: string | null; creator_upper: string | null; cursor: string | null; processed: number; job_id: string;
  error: string | null; created_at: Date; updated_at: Date; completed_at: Date | null };
type Job = { runId: string; phase: "news" | "creator"; cursor: string | null };
const live = (state: string | undefined) => ["created", "retry", "active"].includes(state ?? "missing");
async function latest(db: Db) { return (await db<Row[]>`SELECT * FROM studio_history_rebuild WHERE scope = 'all'`)[0]; }
async function jobState(row: Row, db: Db) {
  const [job] = await db`SELECT state FROM pgboss.job WHERE name = ${historyRebuildQueue.name} AND id = ${row.job_id}`;
  return job?.state as string | undefined;
}

/** Saved progress only. Reading never starts work, counts source bodies, or calls a model. */
export async function historyIndexStatus(): Promise<HistoryIndexStatus> {
  // One MVCC snapshot, including across a committed continuation. A fresh read needs no pg-boss schema.
  return sql.begin("isolation level repeatable read read only", async db => {
    const row = await latest(db);
    const job = row && ["queued", "running"].includes(row.state) ? await jobState(row, db) : undefined;
    const interrupted = row && ["queued", "running"].includes(row.state) && !live(job);
    const status: HistoryIndexStatus = { policy: historyIndexPolicy, indexedPolicy: row?.policy ?? null, runId: row?.id ?? null,
      state: !row ? "not_started" : row.policy !== historyIndexPolicy ? "outdated" : interrupted ? "failed" : job === "active" ? "running" : row.state,
      phase: row?.phase ?? "news", processed: row?.processed ?? 0, batchSize: 50,
      error: interrupted ? "历史索引任务已中断，可从已保存位置重试" : row?.error ?? null,
      startedAt: row?.created_at.toISOString() ?? null, updatedAt: row?.updated_at.toISOString() ?? null, completedAt: row?.completed_at?.toISOString() ?? null };
    return status;
  });
}

export async function submitHistoryRebuild(input: unknown, actor: string) {
  const options = z.object({ retryFailed: z.boolean().optional() }).strict().parse(input);
  await ensureQueue(historyRebuildQueue.name, historyRebuildQueue.options);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.history.rebuild', 0))`;
    const previous = await latest(db);
    if (previous?.policy === historyIndexPolicy) {
      if (previous.state === "completed" || live(await jobState(previous, db))) return { queued: false, runId: previous.id };
      if (!options.retryFailed) throw new Conflict("历史索引任务已中断，请明确重试；已完成进度会保留");
      const jobId = await enqueueOn(historyRebuildQueue, { runId: previous.id, phase: previous.phase as Job["phase"], cursor: previous.cursor }, { group: { id: "history-index" } }, db);
      if (!jobId) throw new Conflict("历史索引尚未排入队列，请稍后重试");
      await db`UPDATE studio_history_rebuild SET state = 'queued', job_id = ${jobId}, error = NULL, updated_at = now() WHERE scope = 'all'`;
      await audit(actor, "studio.history.rebuild.retry", `history:${previous.id}`, null, null, { processed: previous.processed }, { db });
      return { queued: true, runId: previous.id };
    }
    const id = randomUUID(), jobId = await enqueueOn(historyRebuildQueue, { runId: id, phase: "news", cursor: null }, { group: { id: "history-index" } }, db);
    if (!jobId) throw new Conflict("历史索引尚未排入队列，请稍后重试");
    const [news] = await db`SELECT id FROM articles ORDER BY id DESC LIMIT 1`;
    const [creator] = await db`SELECT id FROM studio_creator_posts ORDER BY id DESC LIMIT 1`;
    await db`INSERT INTO studio_history_rebuild (scope, id, policy, state, phase, news_upper, creator_upper, job_id)
      VALUES ('all', ${id}, ${historyIndexPolicy}, 'queued', 'news', ${news?.id ?? null}, ${creator?.id ?? null}, ${jobId})
      ON CONFLICT (scope) DO UPDATE SET id = EXCLUDED.id, policy = EXCLUDED.policy, state = 'queued', phase = 'news',
        news_upper = EXCLUDED.news_upper, creator_upper = EXCLUDED.creator_upper, cursor = NULL, processed = 0,
        job_id = EXCLUDED.job_id, error = NULL, created_at = now(), updated_at = now(), completed_at = NULL`;
    await audit(actor, "studio.history.rebuild.start", `history:${id}`, null, null, { policy: historyIndexPolicy }, { db });
    return { queued: true, runId: id };
  });
}

/** Worker-only catch-up; terminal failures wait for explicit retry instead of looping forever. */
export async function scheduleHistoryRebuild() {
  const status = await historyIndexStatus();
  return ["not_started", "outdated"].includes(status.state)
    ? submitHistoryRebuild({}, "system:studio.history.rebuild") : { queued: false, runId: status.runId };
}

export function createHistoryRebuildQueue(host = createHostResourceMonitor(), disk = createDiskResourceMonitor(), database = createDatabaseResourceMonitor()) {
  const admit = createCollectionAdmission({ host, disk, database, heavy: true, enabled: () => true });
  let gate: ReturnType<typeof admit> | undefined;
  const allowed = async (db: Db = sql) => !!gate?.canStart() && await backgroundWorkHasPriority(db) && !!gate?.canStart();
  return defineQueue<Job>({ name: "studio.history.rebuild",
    options: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 5, groupConcurrency: 1 },
    admission: () => { const active = admit(); gate = active;
      return { canStart: db => allowed(db), stop() { active.stop(); if (gate === active) gate = undefined; } }; },
    async run(jobs) {
      for (const job of jobs) {
        if (!await allowed()) throw new QueueDeferred("资源不足或正常采集处理中，历史索引保留原进度等待");
        await sql.begin(async db => {
          await db`SET LOCAL statement_timeout = '30s'`;
          await db`SET LOCAL lock_timeout = '1s'`;
          await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.history.rebuild', 0))`;
          const row = await latest(db);
          if (!row || row.id !== job.runId || row.policy !== historyIndexPolicy || row.phase !== job.phase || row.cursor !== job.cursor || row.state === "completed") return;
          if (!await allowed(db)) throw new QueueDeferred("资源不足或正常采集处理中，历史索引保留原进度等待");
          // Lock source rows before reading bodies; a concurrent correction cannot be replaced by stale terms.
          const ids = job.phase === "news"
            ? await db<{ id: string }[]>`SELECT id FROM articles WHERE id <= ${row.news_upper}
              ${row.cursor === null ? db`` : db`AND id > ${row.cursor}`} ORDER BY id LIMIT 50 FOR UPDATE`
            : await db<{ id: string }[]>`SELECT id FROM studio_creator_posts WHERE id <= ${row.creator_upper}::uuid
              ${row.cursor === null ? db`` : db`AND id > ${row.cursor}::uuid`} ORDER BY id LIMIT 50 FOR UPDATE`;
          for (const item of ids) {
            if (!gate?.canStart()) throw new QueueDeferred("资源不足，历史索引保留原进度等待");
            await indexHistoryMaterial(db, (job.phase === "news" ? "news:" : "creator:") + item.id);
          }
          const phase = ids.length < 50 ? job.phase === "news" ? "creator" : "done" : job.phase;
          const cursor = phase !== job.phase ? null : ids.at(-1)?.id ?? row.cursor;
          const nextId = phase === "done" ? row.job_id : await enqueueOn(historyRebuildQueue,
            { runId: row.id, phase, cursor }, { group: { id: "history-index" } }, db);
          if (!nextId) throw new Error("历史索引续批未能持久保存");
          await db`UPDATE studio_history_rebuild SET state = ${phase === "done" ? "completed" : "queued"}, phase = ${phase},
            cursor = ${cursor}, processed = processed + ${ids.length}, job_id = ${nextId}, error = NULL,
            updated_at = now(), completed_at = ${phase === "done" ? new Date() : null} WHERE scope = 'all'`;
        });
      }
    },
  });
}
export const historyRebuildQueue = createHistoryRebuildQueue();
