import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { contentLink, contentImport, submitContentImport } from "./content-imports.ts";
import { newsImport, submitNewsImport } from "./news-imports.ts";
import { currentWindow } from "./topic-batches.ts";
import { currentColumns } from "./topic-columns.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { supplementCurrentTopic, supplementTopicBatch } from "./topic-supplements.ts";
import { mediaProcessingStatus, enqueueMediaProcessing } from "./media-jobs.ts";
import type { TopicBatchMaterial, TopicColumn } from "../contracts.ts";

const scopeSchema = z.object({ startsAt: z.iso.datetime(), columnId: z.string().min(1).max(80) }).strict();
const fields = sql`id, starts_at AS "startsAt", ends_at AS "endsAt", column_id AS "columnId", kind, url,
  import_id AS "importId", material_id AS "materialId", state, result_batch_id AS "resultBatchId", error, updated_at AS "updatedAt"`;
type Entry = { id: string; starts_at: Date; ends_at: Date; column_id: string; kind: "news" | "creator"; url: string;
  import_id: string | null; material_id: string | null; state: string; retry_import: boolean };
type ImportRow = { id: string; startsAt: Date; endsAt: Date; columnId: string; kind: "news" | "creator"; url: string;
  importId: string | null; materialId: string | null; state: string; resultBatchId: string | null; error: string | null; updatedAt: Date };

function identity(kind: "news" | "creator", url: string) {
  let key = url;
  try { key = kind === "news" ? identityKeyForUrl(url) ?? url : contentLink(url).url; } catch { /* Invalid lines receive their own explicit failure. */ }
  return createHash("sha256").update(key).digest("hex");
}

/** Register scope before starting existing asynchronous imports. No page lifetime is involved. */
export async function submitTopicSupplementImports(input: unknown, actor: string) {
  const value = scopeSchema.extend({ batchId: z.uuid().optional(), links: z.array(z.object({ kind: z.enum(["news", "creator"]), url: z.string().trim().min(1).max(8000) }).strict()).min(1).max(20) }).parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.supplement.imports', 0))`;
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    let endsAt: string, columns: TopicColumn[];
    if (value.batchId) {
      const [batch] = await db<{ startsAt: Date; endsAt: Date; columns: TopicColumn[] }[]>`SELECT starts_at AS "startsAt", ends_at AS "endsAt", columns FROM studio_topic_batches WHERE id = ${value.batchId}`;
      if (!batch || batch.startsAt.toISOString() !== new Date(value.startsAt).toISOString()) throw new Conflict("批次已经改变，请刷新后再补充");
      endsAt = batch.endsAt.toISOString(); columns = batch.columns;
    } else {
      const window = await currentWindow();
      if (window.stage !== "collecting" || window.startsAt !== new Date(value.startsAt).toISOString()) throw new Conflict("本期已截止，请刷新后再补充");
      endsAt = window.endsAt; columns = await currentColumns(db);
    }
    if (!columns.some(column => column.enabled && column.id === value.columnId)) throw new Conflict("栏目已改变，请刷新后再补充");
    const rows: ImportRow[] = [];
    for (const link of value.links) {
      const [row] = await db<ImportRow[]>`INSERT INTO studio_topic_supplement_imports (id, starts_at, ends_at, column_id, kind, identity_key, url)
        VALUES (${randomUUID()}, ${value.startsAt}, ${endsAt}, ${value.columnId}, ${link.kind}, ${identity(link.kind, link.url)}, ${link.url})
        ON CONFLICT (starts_at, column_id, kind, identity_key) DO UPDATE SET
          url = CASE WHEN studio_topic_supplement_imports.state = 'failed' THEN EXCLUDED.url ELSE studio_topic_supplement_imports.url END
        RETURNING ${fields}`;
      if (!rows.some(item => item.id === row!.id)) rows.push(row!);
    }
    await audit(actor, "studio.topic.supplement.imports", `window:${value.startsAt}`, null, null, { columnId: value.columnId, count: rows.length }, { db });
    return { rows };
  });
}

export async function topicSupplementImports(input: unknown) {
  const value = scopeSchema.extend({ page: z.coerce.number().int().min(1).default(1) }).parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [count] = await db`SELECT count(*)::int AS total FROM studio_topic_supplement_imports WHERE starts_at = ${value.startsAt} AND column_id = ${value.columnId}`;
    const rows = await db`SELECT ${fields} FROM studio_topic_supplement_imports WHERE starts_at = ${value.startsAt} AND column_id = ${value.columnId}
      ORDER BY created_at DESC, id LIMIT 20 OFFSET ${(value.page - 1) * 20}`;
    return { rows, total: count!.total, page: value.page, limit: 20 };
  });
}

export async function retryTopicSupplementImport(id: string, actor: string) {
  z.uuid().parse(id);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.supplement.imports', 0))`;
    const [row] = await db`SELECT id, state FROM studio_topic_supplement_imports WHERE id = ${id} FOR UPDATE`;
    if (!row) return null;
    if (row.state === "failed") {
      await db`UPDATE studio_topic_supplement_imports SET state = 'queued', retry_import = true, error = NULL, updated_at = now() WHERE id = ${id}`;
      await audit(actor, "studio.topic.supplement.retry", `supplement:${id}`, null, null, {}, { db });
    }
    const [item] = await db`SELECT ${fields} FROM studio_topic_supplement_imports WHERE id = ${id}`;
    return item;
  });
}

/** Every minute, continue a bounded set of saved links; imports retain their original queues and admission. */
export async function scheduleTopicSupplementImports() {
  return sql.begin(async db => {
    const [lock] = await db`SELECT pg_try_advisory_xact_lock(hashtextextended('studio.topic.supplement.imports', 0)) AS acquired`;
    if (!lock!.acquired) return { processed: 0 };
    const entries = await db<Entry[]>`SELECT * FROM studio_topic_supplement_imports WHERE state NOT IN ('applied', 'failed')
      ORDER BY updated_at, id LIMIT 20 FOR UPDATE`;
    for (const entry of entries) {
      try {
        await db.savepoint(async step => {
        let imported;
        if (!entry.import_id || entry.retry_import) {
          imported = (entry.kind === "news" ? await submitNewsImport({ url: entry.url, retryFailed: entry.retry_import }, "system:studio.topic.supplements")
            : await submitContentImport({ url: entry.url, retryFailed: entry.retry_import }, "system:studio.topic.supplements")).item;
          entry.import_id = imported!.id;
          await step`UPDATE studio_topic_supplement_imports SET import_id = ${entry.import_id}, retry_import = false WHERE id = ${entry.id}`;
        } else imported = entry.kind === "news" ? await newsImport(entry.import_id) : await contentImport(entry.import_id);
        if (!imported || ["failed", "interrupted", "login_required", "rate_limited"].includes(imported.state))
          throw new Conflict(imported?.errorCode === "login_required" ? "平台需要登录，请更新登录后重试" : imported?.errorCode === "rate_limited" ? "平台限流，请稍后重试" : "原文导入未完成，请检查导入状态后重试");
        let state = "reading", resultBatchId: string | null = null, notice: string | null = null;
        if (imported.materialId) {
          entry.material_id = imported.materialId;
          const window = { startsAt: entry.starts_at, endsAt: entry.ends_at, earliestStart: entry.starts_at };
          const [selected] = await step<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(step, window, [entry.material_id!], true)}) selected`;
          const ready = selected && selected.evidence.body.trim() && ["ok", "collected", "transcribed"].includes(selected.evidence.bodyState);
          state = ready ? "waiting_cutoff" : "waiting_transcript";
          if (!ready) {
            if (!selected || selected.evidence.kind !== "video") throw new Conflict("材料尚无完整正文，请检查原文后重试");
            const status = await mediaProcessingStatus(entry.material_id!.slice(8));
            if (!status) throw new Conflict("原视频材料已不可用，请检查情报库");
            if (status.state === "failed" && !entry.retry_import) throw new Conflict("视频转写未完成，请检查转写组件或平台状态后重试这条");
            if (status.enabled && ["failed", "not_queued"].includes(status.state))
              await enqueueMediaProcessing(entry.material_id!.slice(8), "system:studio.topic.supplements", { retryFailed: entry.retry_import });
            if (!status.enabled) notice = "本地媒体处理尚未启用，请到设置启用后继续等待";
          }
          if (ready) {
            const selection = { columnId: entry.column_id, materialIds: [entry.material_id] };
            const current = await currentWindow();
            if (current.stage === "collecting" && current.startsAt === entry.starts_at.toISOString()) {
              try { await supplementCurrentTopic({ ...selection, startsAt: current.startsAt }, "system:studio.topic.supplements"); state = "applied"; }
              catch (error) {
                // A cutoff can occur between the clock read and the locked binding; keep this exact scope pending.
                if (!(error instanceof Conflict) || Date.now() < entry.ends_at.getTime()) throw error;
              }
            } else {
              const [root] = await step`SELECT id FROM studio_topic_batches WHERE starts_at = ${entry.starts_at} AND ends_at = ${entry.ends_at} AND root_batch_id IS NULL LIMIT 1`;
              if (root) {
                const result = await supplementTopicBatch(root.id, selection, "system:studio.topic.supplements");
                if (!result) throw new Conflict("原期次已不可用，未转入其他期次");
                resultBatchId = result.batchId; state = "applied";
              }
            }
          }
        }
        await step`UPDATE studio_topic_supplement_imports SET material_id = ${entry.material_id}, state = ${state}, result_batch_id = ${resultBatchId}, error = ${notice}, updated_at = now() WHERE id = ${entry.id}`;
        });
      } catch (error) {
        const message = error instanceof Conflict ? error.message : error instanceof z.ZodError ? "链接格式不受支持，请使用完整新闻或七平台作品链接" : "补充未完成，请检查原文导入或后台日志后重试";
        await db`UPDATE studio_topic_supplement_imports SET state = 'failed', error = ${message}, updated_at = now() WHERE id = ${entry.id}`;
      }
    }
    return { processed: entries.length };
  });
}
