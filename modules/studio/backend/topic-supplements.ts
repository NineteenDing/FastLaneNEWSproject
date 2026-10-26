import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { intelligenceEvidence } from "./intelligence.ts";
import { createImageAssets } from "./image-assets.ts";
import { currentWindow } from "./topic-batches.ts";
import { currentColumns } from "./topic-columns.ts";
import { submitTopicPreview } from "./topic-preview.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import type { TopicBatchMaterial, TopicColumn } from "../contracts.ts";

const selectionSchema = z.object({ columnId: z.string().min(1).max(80), materialIds: z.array(z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/)).min(1).max(50) });
async function selectedMaterials(db: Tx, window: { startsAt: Date; endsAt: Date }, previous: TopicBatchMaterial[], value: z.infer<typeof selectionSchema>) {
  const ids = [...new Set(value.materialIds)];
  const selected = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db, { ...window, earliestStart: window.startsAt }, ids, true)}) selected`;
  if (selected.length !== ids.length) throw new Conflict("部分材料尚未收录，请先完成读取后再选择");
  if (selected.some(({ evidence }) => !evidence.body.trim() || !["ok", "collected", "transcribed"].includes(evidence.bodyState)))
    throw new Conflict("部分正文或视频转写尚未就绪，未重选；请等待处理后再提交");
  const byId = new Map(previous.map(item => [item.id, item]));
  for (const { evidence } of selected) byId.set(evidence.id, { ...evidence,
    suggestedColumnIds: [...new Set([...(byId.get(evidence.id)?.suggestedColumnIds ?? []), value.columnId])].sort(),
    ...(evidence.publishedAt && Date.parse(evidence.publishedAt) >= window.endsAt.getTime() ? { freshness: "background" as const } : {}) });
  const materials = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (materials.length > 50 || Buffer.byteLength(JSON.stringify(materials), "utf8") > 8 * 1024 ** 2)
    throw new Conflict("本期补充超过50条或8MiB完整证据额度，未截断原文，请减少本次补充");
  return materials;
}

async function retainImages(db: Tx, owner: string, materials: TopicBatchMaterial[]) {
  const assets = materials.flatMap(item => [...(item.sourceImages?.images.map(image => image.assetId) ?? []), ...(item.transcript?.frames?.map(frame => frame.assetId) ?? []),
    ...(item.source.avatarUrl ? [new URL(item.source.avatarUrl, "http://local.invalid").searchParams.get("v") ?? ""] : [])]).filter(id => /^[a-f0-9]{64}$/.test(id));
  if (assets.length) await createImageAssets().setReferences(owner, [...new Set(assets)], db);
}

export async function supplementCurrentTopic(input: unknown, actor: string) {
  const value = selectionSchema.extend({ startsAt: z.iso.datetime() }).strict().parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    await db`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const window = await currentWindow();
    if (window.stage !== "collecting" || window.startsAt !== new Date(value.startsAt).toISOString()) throw new Conflict("本期已截止或尚未开始，请刷新后选择当期");
    const columns = await currentColumns(db);
    if (!columns.some(column => column.enabled && column.id === value.columnId)) throw new Conflict("栏目已停用或改变，请刷新后再提交");
    const [old] = await db<{ materials: TopicBatchMaterial[]; version: number }[]>`SELECT materials, version FROM studio_topic_supplement_windows WHERE starts_at = ${window.startsAt}`;
    const materials = await selectedMaterials(db, { startsAt: new Date(window.startsAt), endsAt: new Date(window.endsAt) }, old?.materials ?? [], value);
    const [same] = await db`SELECT starts_at FROM studio_topic_supplement_windows WHERE starts_at = ${window.startsAt} AND materials = ${db.json(materials as never)}::jsonb`;
    if (same) return { changed: false, version: old!.version };
    await db`INSERT INTO studio_topic_supplement_windows (starts_at, ends_at, materials) VALUES (${window.startsAt}, ${window.endsAt}, ${db.json(materials as never)})
      ON CONFLICT (starts_at) DO UPDATE SET materials = EXCLUDED.materials, version = studio_topic_supplement_windows.version + 1, updated_at = now()`;
    await retainImages(db, `topic-window:${window.startsAt}`, materials);
    await audit(actor, "studio.topic.current.supplement", `window:${window.startsAt}`, null, null, { columnId: value.columnId, materials: value.materialIds.length }, { db });
    return { changed: true, version: (old?.version ?? 0) + 1 };
  });
}

/** Retry pending captured additions without requiring the page to remain open or enabling a paid service. */
export async function scheduleTopicSupplementPreviews() {
  if (!await modelWorkAllowed()) return { queued: false };
  const window = await currentWindow();
  if (window.stage !== "collecting") return { queued: false };
  const [row] = await sql<{ version: number }[]>`SELECT version FROM studio_topic_supplement_windows
    WHERE starts_at = ${window.startsAt} AND submitted_version < version`;
  if (!row) return { queued: false };
  try {
    const result = await submitTopicPreview({ startsAt: window.startsAt }, "system:studio.topic.supplements");
    await sql`UPDATE studio_topic_supplement_windows SET submitted_version = greatest(submitted_version, ${row.version}), last_error = NULL WHERE starts_at = ${window.startsAt}`;
    return { queued: result.queued };
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    await sql`UPDATE studio_topic_supplement_windows SET last_error = ${error.message} WHERE starts_at = ${window.startsAt}`;
    return { queued: false, waiting: true };
  }
}

/** A new material revision shares the immutable root, while additions never claim natural collection ownership. */
export async function supplementTopicBatch(batchId: string, input: unknown, actor: string) {
  z.uuid().parse(batchId);
  const value = selectionSchema.strict().parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    await db`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const [parent] = await db<{ root: string }[]>`SELECT coalesce(root_batch_id, id) AS root FROM studio_topic_batches WHERE id = ${batchId}`;
    if (!parent) return null;
    const [latest] = await db<{ id: string; startsAt: Date; endsAt: Date; columns: TopicColumn[]; materials: TopicBatchMaterial[]; revision: number }[]>`
      SELECT id, starts_at AS "startsAt", ends_at AS "endsAt", columns, supplemental_materials AS materials, coalesce(revision, 1) AS revision
      FROM studio_topic_batches WHERE id = ${parent.root} OR root_batch_id = ${parent.root} ORDER BY coalesce(revision, 1) DESC LIMIT 1`;
    if (!latest!.columns.some(column => column.id === value.columnId && column.enabled)) throw new Conflict("栏目已停用或改变，请刷新后选择有效栏目");
    const materials = await selectedMaterials(db, latest!, latest!.materials, value);
    const json = db.json(materials as never);
    const [existing] = await db<{ id: string }[]>`SELECT id FROM studio_topic_batches
      WHERE (id = ${parent.root} OR root_batch_id = ${parent.root}) AND columns = ${db.json(latest!.columns as never)}::jsonb AND supplemental_materials = ${json}::jsonb
      ORDER BY coalesce(revision, 1) DESC LIMIT 1`;
    if (existing) return { batchId: existing.id, created: false };
    const id = randomUUID();
    await db`INSERT INTO studio_topic_batches (id, starts_at, ends_at, frozen_at, audience, columns, source_coverage, root_batch_id, revision, supplemental_materials)
      SELECT ${id}, starts_at, ends_at, ${new Date()}, audience, columns, source_coverage, ${parent.root}, ${latest!.revision + 1}, ${json}
      FROM studio_topic_batches WHERE id = ${latest!.id}`;
    await retainImages(db, `topic-supplement:${id}`, materials);
    await audit(actor, "studio.topic.supplement", `batch:${id}`, null, null, { rootBatchId: parent.root, columnId: value.columnId, materials: value.materialIds.length }, { db });
    return { batchId: id, created: true };
  });
}
