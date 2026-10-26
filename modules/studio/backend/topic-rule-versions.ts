import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { currentColumns } from "./topic-columns.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { stableJson } from "@aihot/backend/lib/ids";

const columnsSchema = z.array(z.object({ id: z.string().min(1).max(80), version: z.number().int().positive() }).strict()).min(1).max(100);
export async function createTopicRuleVersion(batchId: string, input: unknown, actor: string, canStart: () => boolean) {
  z.uuid().parse(batchId); const value = z.object({ columns: columnsSchema }).strict().parse(input);
  if (!await modelWorkAllowed()) throw new Conflict("模型调用尚未启用，不能提交规则重选");
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const [parent] = await db<{ id: string; root: string; supplements: unknown[] }[]>`SELECT id, coalesce(root_batch_id, id) AS root, supplemental_materials AS supplements FROM studio_topic_batches WHERE id = ${batchId}`;
    if (!parent) return null;
    const columns = await currentColumns(db);
    const versions = (rows: Array<{id: string; version: number}>) => stableJson(rows.map(({id, version}) => ({id, version})).sort((a, b) => a.id.localeCompare(b.id)));
    if (versions(value.columns) !== versions(columns)) throw new Conflict("栏目规则已更新，请刷新规则预览后再提交");
    const [existing] = await db<{ id: string }[]>`SELECT id FROM studio_topic_batches WHERE (id = ${parent.root} OR root_batch_id = ${parent.root})
      AND columns = ${db.json(columns.map(column => ({ ...column })))}::jsonb AND supplemental_materials = ${db.json(parent.supplements as never)}::jsonb ORDER BY coalesce(revision, 1) DESC LIMIT 1`;
    if (existing?.id === parent.root) throw new Conflict("最新栏目规则与原批次相同，无需重新选题");
    if (existing) return { batchId: existing.id, created: false };
    if (!canStart()) return { waiting: true as const };
    const [next] = await db<{ version: number }[]>`SELECT coalesce(max(coalesce(revision, 1)), 1) + 1 AS version FROM studio_topic_batches WHERE id = ${parent.root} OR root_batch_id = ${parent.root}`;
    const id = randomUUID();
    await db`INSERT INTO studio_topic_batches (id, starts_at, ends_at, frozen_at, audience, columns, source_coverage, root_batch_id, revision, supplemental_materials)
      SELECT ${id}, starts_at, ends_at, ${new Date()}, audience, ${db.json(columns.map(column => ({ ...column })))}, source_coverage, id, ${next!.version}, ${db.json(parent.supplements as never)}
      FROM studio_topic_batches WHERE id = ${parent.root}`;
    await audit(actor, "studio.topic.rules.revise", `batch:${id}`, null, null, { rootBatchId: parent.root, revision: next!.version }, { db });
    return { batchId: id, created: true };
  });
}

export async function topicRuleVersions(batchId: string) {
  z.uuid().parse(batchId);
  const [parent] = await sql<{ root: string }[]>`SELECT coalesce(root_batch_id, id) AS root FROM studio_topic_batches WHERE id = ${batchId}`;
  if (!parent) return null;
  const rows = await sql<{ id: string; revision: number }[]>`SELECT id, coalesce(revision, 1) AS revision FROM studio_topic_batches
    WHERE id = ${parent.root} OR root_batch_id = ${parent.root} ORDER BY coalesce(revision, 1) DESC LIMIT 100`;
  return { rootBatchId: parent.root, rows };
}
