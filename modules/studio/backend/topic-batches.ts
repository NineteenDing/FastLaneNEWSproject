import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { currentColumns, topicAudience } from "./topic-columns.ts";
import { intelligenceEvidence } from "./intelligence.ts";
import { topicPlan, topicDurationMs as durationMs } from "./topic-plan.ts";
import { materialAnalysisReadings } from "./material-analysis-state.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { captureSourceCoverage } from "./topic-source-coverage.ts";
import { batchEvidence } from "./topic-evidence.ts";
import type { CurrentTopicBatch, TopicBatch, TopicBatchMaterial, TopicColumn, TopicRecommendations, TopicPresentation } from "../contracts.ts";

export async function currentWindow() {
  const anchorMs = Date.parse((await topicPlan()).startsAt);
  const start = anchorMs + Math.max(0, Math.floor((Date.now() - anchorMs) / durationMs)) * durationMs;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + durationMs).toISOString(),
    stage: Date.now() < anchorMs ? "scheduled" as const : "collecting" as const };
}

export async function currentTopicBatch(): Promise<CurrentTopicBatch> {
  const window = await currentWindow();
  const start = new Date(window.startsAt), end = new Date(window.endsAt);
  const [counts] = await sql.begin("isolation level repeatable read read only", async db => {
    const earliest = await currentEvidenceStart(db, start);
    return db<{ materialCount: number; videoWithoutTranscriptCount: number; analysisCompletedCount: number }[]>`
      SELECT count(*)::int AS "materialCount", count(*) FILTER (WHERE evidence->>'bodyState' = 'not_transcribed')::int AS "videoWithoutTranscriptCount",
        count(*) FILTER (WHERE l.state = 'completed' AND l.result->>'disposition' <> 'pending')::int AS "analysisCompletedCount"
      FROM (${currentEvidence(db, { startsAt: start, endsAt: end }, earliest)}) materials
      LEFT JOIN studio_history_index h ON h.material_id = materials.id
      LEFT JOIN studio_live_material_analyses l ON l.material_id = materials.id AND l.source_key = h.knowledge->>'sourceKey'`;
  });
  return { ...window, timeZone: "Asia/Hong_Kong", recommendationState: "not_generated",
    ...counts!, analysisPendingCount: counts!.materialCount - counts!.analysisCompletedCount };
}

type BatchRow = { id: string; rootBatchId: string | null; revision: number; startsAt: Date; endsAt: Date; frozenAt: Date; audience: string; columns: TopicColumn[]; materialCount: number; recommendationState: TopicBatch["recommendationState"]; reviewVerdict: TopicBatch["reviewVerdict"]; draftCount: number; adoptedDirectionCount: number; adoptedDirectionIds: string[]; finalizedDraftCount: number };
const hongKongDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });
function displayDeadline(end: Date) { return new Date(Date.parse(`${hongKongDay.format(end)}T00:00:00+08:00`) + 2 * 86400_000); }
function project(row: BatchRow): TopicBatch {
  return { ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), frozenAt: row.frozenAt.toISOString(),
    selectionState: row.draftCount ? "adopted" : Date.now() >= displayDeadline(row.endsAt).getTime() ? "incomplete" : "not_adopted",
    timeZone: "Asia/Hong_Kong", stage: "frozen", adoptionState: row.draftCount ? "adopted" : "not_adopted" };
}

/** Display grace is separate from collection windows and never delays the next batch's work. */
export async function topicPresentation(): Promise<TopicPresentation> {
  const collection = await currentTopicBatch(), now = new Date();
  const [latest] = await sql<BatchRow[]>`SELECT * FROM (${batchRows(sql)}) batches
    WHERE "endsAt" <= ${now} AND "endsAt" > ${new Date(now.getTime() - durationMs)}
    ORDER BY "endsAt" DESC, revision DESC, id LIMIT 1`;
  const until = latest ? displayDeadline(latest.endsAt) : null;
  const batch = latest && until!.getTime() > now.getTime() ? project(latest) : null;
  return { collection, batch, displayUntil: batch ? until!.toISOString() : null };
}
function batchRows(db: typeof sql | Tx) {
  return db`SELECT b.id, b.root_batch_id AS "rootBatchId", coalesce(b.revision, 1) AS revision, b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.frozen_at AS "frozenAt", b.audience, b.columns,
    (SELECT count(*)::int FROM (${batchEvidence(db)}) m WHERE m.batch_id = b.id) AS "materialCount",
    (SELECT count(*)::int FROM studio_writing_projects d WHERE d.batch_id = b.id) AS "draftCount",
    (SELECT count(*)::int FROM studio_writing_projects d JOIN studio_language_samples sample ON sample.project_id = d.id
      WHERE d.batch_id = b.id) AS "finalizedDraftCount",
    coalesce((SELECT jsonb_agg(DISTINCT direction->>'id') FROM studio_writing_projects d,
      jsonb_array_elements(d.snapshot->'directions') direction WHERE d.batch_id = b.id), '[]'::jsonb) AS "adoptedDirectionIds",
    (SELECT count(DISTINCT direction->>'id')::int FROM studio_writing_projects d,
      jsonb_array_elements(d.snapshot->'directions') direction WHERE d.batch_id = b.id) AS "adoptedDirectionCount",
    CASE WHEN v.output IS NOT NULL THEN 'reviewed'
      WHEN EXISTS (SELECT 1 FROM studio_topic_recommendations r WHERE r.batch_id = b.id AND r.result IS NOT NULL)
      THEN 'draft' ELSE 'not_generated' END AS "recommendationState", v.output->>'verdict' AS "reviewVerdict"
      FROM studio_topic_batches b LEFT JOIN studio_topic_reviews v ON v.batch_id = b.id`;
}

function frozenEvidence(db: typeof sql | Tx, batchId: string, ids: string[]) {
  return db`SELECT evidence FROM (${batchEvidence(db, batchId)}) materials WHERE material_id = ANY(${ids}::text[])
    UNION ALL SELECT item->'material' AS evidence FROM studio_topic_history h,
      jsonb_array_elements(h.snapshot->'items') item WHERE h.batch_id = ${batchId} AND item->'material'->>'id' = ANY(${ids}::text[])`;
}

export async function frozenTopicMaterials(db: typeof sql | Tx, batchId: string, ids: string[]): Promise<TopicBatchMaterial[]> {
  if (!ids.length) return [];
  const rows = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${frozenEvidence(db, batchId, [...new Set(ids)])}) materials
    ORDER BY (evidence->>'collectedAt')::timestamptz, evidence->>'id'`;
  return rows.map(row => row.evidence);
}

export async function frozenTopicReferences(db: typeof sql | Tx, batchId: string, ids: string[]): Promise<TopicRecommendations["referenceMaterials"]> {
  return ids.length ? db<TopicRecommendations["referenceMaterials"]>`SELECT evidence->>'id' AS id,
    evidence->>'title' AS title, evidence->>'url' AS url, evidence->'source' AS source, evidence->>'excerpt' AS excerpt,
    evidence->>'kind' AS kind, evidence->'metrics' AS metrics, evidence->>'publishedAt' AS "publishedAt"
    FROM (${frozenEvidence(db, batchId, [...new Set(ids)])}) materials ORDER BY (evidence->>'collectedAt')::timestamptz, evidence->>'id'` : [];
}
/** Live previews and frozen snapshots agree on which late commits still need a batch. */
function pendingEvidence(db: Tx, window: { startsAt: Date; endsAt: Date }, earliestStart: Date) {
  return db`SELECT * FROM (${intelligenceEvidence(db, { ...window, earliestStart })}) materials
    WHERE NOT EXISTS (SELECT 1 FROM studio_topic_batch_materials assigned WHERE assigned.material_id = materials.id)`;
}
/** Current additions remain separate from natural collection ownership until the cutoff freezes both views. */
function currentEvidence(db: Tx, window: { startsAt: Date; endsAt: Date }, earliestStart: Date) {
  const base = pendingEvidence(db, window, earliestStart);
  const supplements = db`SELECT extra FROM studio_topic_supplement_windows w, jsonb_array_elements(w.materials) extra WHERE w.starts_at = ${window.startsAt}`;
  return db`SELECT base.id, base."collectedAt", base.evidence || CASE WHEN additions.extra IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('suggestedColumnIds', additions.extra->'suggestedColumnIds') END AS evidence
    FROM (${base}) base LEFT JOIN (${supplements}) additions ON additions.extra->>'id' = base.id
    UNION ALL SELECT extra->>'id' AS id, (extra->>'collectedAt')::timestamptz AS "collectedAt", extra AS evidence FROM (${supplements}) additions
      WHERE NOT EXISTS (SELECT 1 FROM (${base}) base WHERE base.id = additions.extra->>'id')`;
}
async function currentEvidenceStart(db: Tx, start: Date) {
  const [range] = await db<{ earliest: Date | null; latest: Date | null }[]>`SELECT min(starts_at) AS earliest, max(ends_at) AS latest FROM studio_topic_batches`;
  // With an overdue unclosed period, its pending evidence belongs there, not to today's window.
  return range!.latest?.getTime() === start.getTime() ? range!.earliest ?? start : start;
}
export async function freezeTopicBatch(input: unknown, actor: string, canStart: () => boolean) {
  const query = z.object({ startsAt: z.iso.datetime() }).strict().parse(input);
  return sql.begin(async db => {
    // Same lock as column writes: freeze either all old rules or all newly committed rules.
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    return freeze(db, new Date(query.startsAt), actor, canStart);
  });
}

/** Recomputed at execution time: stale queue messages never skip or overwrite a period. */
export async function nextTopicBatchStart(db: typeof sql | Tx = sql) {
  const plan = await topicPlan(db);
  if (!plan.enabled) return null;
  const [range] = await db<{ latest: Date | null }[]>`SELECT max(ends_at) AS latest FROM studio_topic_batches`;
  const start = range!.latest ?? new Date(plan.startsAt);
  return start.getTime() + durationMs <= Date.now() ? start : null;
}

export async function freezeNextTopicBatch(canStart: () => boolean) {
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const start = await nextTopicBatchStart(db);
    return start ? freeze(db, start, "system:studio.topic.schedule", canStart) : { due: false };
  });
}

async function freeze(db: Tx, start: Date, actor: string, canStart: () => boolean) {
    await db`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const end = new Date(start.getTime() + durationMs), now = new Date();
    const anchorMs = Date.parse((await topicPlan(db)).startsAt);
    if ((start.getTime() - anchorMs) % durationMs !== 0 || end.getTime() > now.getTime())
      throw new Conflict("只能冻结已截止且与两日计划对齐的批次");
    const [existing] = await db<BatchRow[]>`SELECT * FROM (${batchRows(db)}) batches WHERE "startsAt" = ${start} AND "rootBatchId" IS NULL`;
    if (existing) return { batch: project(existing) };
    const [range] = await db<{ earliest: Date | null; latest: Date | null }[]>`SELECT min(starts_at) AS earliest, max(ends_at) AS latest FROM studio_topic_batches`;
    if (!range!.latest && start.getTime() !== anchorMs) throw new Conflict("首个批次必须从选题计划的起点开始，不能提前或跳过首批");
    if (range!.latest && range!.latest.getTime() !== start.getTime()) throw new Conflict("请按时间顺序冻结相邻批次，不能跳过或重叠已有窗口");
    if (!canStart()) return { waiting: true as const };
    // No queue schema is required on a fresh installation with no submitted media tasks.
    if ((await db`SELECT post_id FROM studio_media_jobs LIMIT 1`).length) {
      const [pending] = await db`SELECT p.id FROM studio_creator_posts p JOIN studio_media_jobs m ON m.post_id = p.id
        AND m.source_fingerprint = p.content_fingerprint
        JOIN pgboss.job j ON j.id = m.job_id AND j.name = 'studio.media.process' AND j.state IN ('created', 'retry', 'active')
        WHERE p.collected_at >= ${range!.earliest ?? start} AND p.collected_at < ${end}
          AND NOT EXISTS (SELECT 1 FROM studio_topic_batch_materials assigned WHERE assigned.material_id = 'creator:' || p.id::text)
          AND NOT EXISTS (SELECT 1 FROM studio_media_transcripts t WHERE t.post_id = p.id AND t.source_fingerprint = p.content_fingerprint)
        LIMIT 1`;
      if (pending) return { waiting: true as const, reason: "media_processing" as const };
    }
    const id = randomUUID(), columns = await currentColumns(db);
    await db`INSERT INTO studio_topic_batches (id, starts_at, ends_at, frozen_at, audience, columns)
      VALUES (${id}, ${start}, ${end}, ${now}, ${topicAudience}, ${db.json(columns.map(column => ({ ...column })))})`;
    // One statement captures all evidence consistently, without a JS array of every body.
    await db`INSERT INTO studio_topic_batch_materials (batch_id, material_id, collected_at, evidence, source_key)
      SELECT ${id}, materials.id, "collectedAt", evidence, h.knowledge->>'sourceKey'
      FROM (${pendingEvidence(db, { startsAt: start, endsAt: end }, range!.earliest ?? start)}) materials
      LEFT JOIN studio_history_index h ON h.material_id = materials.id`;
    // Shared root rows retain their original ownership. Old selected material is stored only in this new snapshot.
    const [addition] = await db<{ materials: TopicBatchMaterial[] }[]>`SELECT coalesce(jsonb_agg(CASE WHEN m.material_id IS NULL THEN extra
      ELSE m.evidence || jsonb_build_object('suggestedColumnIds', extra->'suggestedColumnIds') END), '[]'::jsonb) AS materials
      FROM studio_topic_supplement_windows w CROSS JOIN LATERAL jsonb_array_elements(w.materials) extra
      LEFT JOIN studio_topic_batch_materials m ON m.batch_id = ${id} AND m.material_id = extra->>'id' WHERE w.starts_at = ${start}`;
    await db`UPDATE studio_topic_batches SET supplemental_materials = ${db.json(addition!.materials as never)} WHERE id = ${id}`;
    await db`DELETE FROM studio_topic_supplement_windows WHERE starts_at = ${start}`;
    const coverage = await captureSourceCoverage(db, { startsAt: start, endsAt: end });
    await db`UPDATE studio_topic_batches SET source_coverage = ${db.json(coverage as never)} WHERE id = ${id}`;
    await audit(actor, "studio.topic.batch.freeze", `batch:${id}`, null, null, { startsAt: start.toISOString(), endsAt: end.toISOString() }, { db });
    const [created] = await db<BatchRow[]>`SELECT * FROM (${batchRows(db)}) batches WHERE id = ${id}`;
    return { batch: project(created!) };
}

export async function topicBatch(id: string) {
  z.uuid().parse(id);
  const [row] = await sql<BatchRow[]>`SELECT * FROM (${batchRows(sql)}) batches WHERE id = ${id}`;
  return row ? { batch: project(row) } : null;
}
export async function topicBatchMaterial(id: string, materialId: string) {
  z.uuid().parse(id);
  z.string().max(100).regex(/^(news:[A-Za-z0-9_-]{1,80}|creator:[0-9a-f-]{36})$/).parse(materialId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [material] = await frozenTopicMaterials(db, id, [materialId]);
    return material ? evidenceDates(material) : null;
  });
}
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
/** A generation captures pending evidence with the same late-arrival/ownership rules as the current page. */
export async function currentTopicEvidence(db: Tx, window: { startsAt: string; endsAt: string }): Promise<TopicBatchMaterial[]> {
  const start = new Date(window.startsAt), end = new Date(window.endsAt);
  const rows = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${currentEvidence(db,
    { startsAt: start, endsAt: end }, await currentEvidenceStart(db, start))}) materials ORDER BY "collectedAt", id`;
  return rows.map(row => row.evidence);
}
export async function currentTopicMaterials(input: unknown) {
  const query = pagination.parse(input), window = await currentWindow();
  const start = new Date(window.startsAt), end = new Date(window.endsAt);
  return sql.begin("isolation level repeatable read read only", async db => {
    const evidence = currentEvidence(db, { startsAt: start, endsAt: end }, await currentEvidenceStart(db, start));
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM (${evidence}) materials`;
    const rows = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${evidence}) materials
      ORDER BY "collectedAt" DESC, id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    const readings = await materialAnalysisReadings(db, rows.map(row => row.evidence.id), await modelWorkAllowed(db));
    return { rows: rows.map(row => { const analysis = readings.get(row.evidence.id) ?? null;
      return { ...evidenceDates(row.evidence), analysis, analysisState: analysis?.state ?? "not_analyzed" };
    }), total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
export async function topicBatches(input: unknown) {
  const query = pagination.extend({ q: z.string().trim().max(200).default(""),
    from: z.iso.date().refine(value => value >= "0001-01-01").optional(),
    to: z.iso.date().refine(value => value >= "0001-01-01").optional() }).refine(value => !value.from || !value.to || value.from <= value.to, "开始日期不能晚于结束日期").parse(input);
  const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  return sql.begin("isolation level repeatable read read only", async db => {
    const where = db`(${query.from ?? null}::date IS NULL OR "endsAt" > (${query.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Hong_Kong'))
      AND (${query.to ?? null}::date IS NULL OR "startsAt" < ((${query.to ?? null}::date + 1)::timestamp AT TIME ZONE 'Asia/Hong_Kong'))
      AND (${pattern} = '%%' OR to_char("startsAt" AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM-DD') ILIKE ${pattern}
        OR to_char("endsAt" AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM-DD') ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM studio_writing_projects d WHERE d.batch_id = batches.id AND d.title ILIKE ${pattern})
        OR EXISTS (SELECT 1 FROM studio_topic_recommendations r LEFT JOIN studio_topic_reviews v ON v.batch_id = r.batch_id,
          jsonb_array_elements(coalesce(v.output->'result'->'directions', r.result->'directions', '[]'::jsonb)) direction,
          jsonb_array_elements_text(direction->'titles') title WHERE r.batch_id = batches.id AND title ILIKE ${pattern}))`;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM (${batchRows(db)}) batches WHERE ${where}`;
    const rows = await db<BatchRow[]>`SELECT * FROM (${batchRows(db)}) batches WHERE ${where} ORDER BY "startsAt" DESC, revision DESC, id LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    return { rows: rows.map(project), total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
function evidenceDates(evidence: TopicBatchMaterial): TopicBatchMaterial {
  return { ...evidence, publishedAt: evidence.publishedAt ? new Date(evidence.publishedAt).toISOString() : null,
    collectedAt: new Date(evidence.collectedAt).toISOString(), updatedAt: new Date(evidence.updatedAt).toISOString(),
    observations: evidence.observations.map(row => ({ ...row, observedAt: new Date(row.observedAt).toISOString() })) };
}
export async function topicBatchMaterials(id: string, input: unknown) {
  z.uuid().parse(id); const query = pagination.parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [batch] = await db`SELECT id FROM studio_topic_batches WHERE id = ${id}`;
    if (!batch) return null;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM (${batchEvidence(db, id)}) materials`;
    const rows = await db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${batchEvidence(db, id)}) materials
      ORDER BY collected_at DESC, material_id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    return { rows: rows.map(row => evidenceDates(row.evidence)), total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
