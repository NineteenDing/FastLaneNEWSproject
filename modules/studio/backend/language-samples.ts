import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import type { LanguageSample, LanguageSamplePage, WritingProject, StyleLearningInput } from "../contracts.ts";

/** One active pointer per user-confirmed draft, retaining its immutable version and old history. */
export async function recordLanguageSample(db: Tx, project: Pick<WritingProject, "id" | "version" | "snapshot">) {
  const columnIds = [...new Set(project.snapshot.directions.map(direction => direction.columnId))].sort();
  await db`INSERT INTO studio_language_samples (project_id, version, column_ids, confirmed_at)
    SELECT project_id, version, ${columnIds}, created_at FROM studio_writing_versions
    WHERE project_id = ${project.id} AND version = ${project.version} AND source = 'final'
    ON CONFLICT (project_id) DO UPDATE SET version = EXCLUDED.version, column_ids = EXCLUDED.column_ids, confirmed_at = EXCLUDED.confirmed_at
    WHERE studio_language_samples.version < EXCLUDED.version`;
}

async function sampleRows(db: Tx, columnIds: string[], limit: number, offset = 0): Promise<LanguageSample[]> {
  const where = columnIds.length ? db`column_ids && ${columnIds}::text[]` : db`true`;
  const rows = await db<Array<Omit<LanguageSample, "source" | "confirmedAt"> & { confirmedAt: Date }>>`
    SELECT s.project_id AS "projectId", s.version::int, v.title, v.content->>'spoken' AS spoken, s.column_ids AS "columnIds", s.confirmed_at AS "confirmedAt"
    FROM studio_language_samples s JOIN studio_writing_versions v ON v.project_id = s.project_id AND v.version = s.version
    WHERE ${where} ORDER BY s.confirmed_at DESC, s.project_id DESC LIMIT ${limit} OFFSET ${offset}`;
  return rows.map(row => ({ ...row, confirmedAt: row.confirmedAt.toISOString(), source: "confirmed_final" }));
}

export async function languageSampleCandidates(columnId: string, db: Tx) { return sampleRows(db, [columnId], 10); }

/** At most three training samples. Only edits retained in an explicitly confirmed
 * final count; held-out samples and unconfirmed saves never enter this input. */
export async function trainingEditExamples(samples: LanguageSample[], db: Tx): Promise<NonNullable<StyleLearningInput["editExamples"]>> {
  const examples: NonNullable<StyleLearningInput["editExamples"]> = [];
  for (const sample of samples.slice(0, 3)) {
    const [baseline] = await db<{ version: number; spoken: string }[]>`SELECT m.version::int, m.content->>'spoken' AS spoken
      FROM studio_writing_versions v JOIN LATERAL (
        SELECT version, content FROM studio_writing_versions WHERE project_id = v.project_id AND version < v.version AND source = 'model'
        ORDER BY version DESC LIMIT 1
      ) m ON true WHERE v.project_id = ${sample.projectId} AND v.version = ${sample.version} AND v.source = 'final' AND v.content->>'spoken' = ${sample.spoken}
      AND EXISTS (SELECT 1 FROM studio_writing_versions e WHERE e.project_id = v.project_id AND e.version > m.version AND e.version < v.version
        AND e.source IN ('manual', 'auto', 'restore') AND e.content->>'spoken' IS DISTINCT FROM m.content->>'spoken')`;
    if (!baseline?.spoken.trim() || baseline.spoken === sample.spoken || Array.from(baseline.spoken).length > 4000) continue;
    const example = { projectId: sample.projectId, finalVersion: sample.version, baselineVersion: baseline.version, beforeSpoken: baseline.spoken };
    if (JSON.stringify([...examples, example]).length > 12000) continue;
    examples.push(example);
  }
  return examples;
}

/** Read a bounded shortlist from the column index; never truncate a sample or scan the whole library. */
export async function languageSamplesForWriting(columnIds: string[], db: Tx): Promise<LanguageSample[]> {
  if (!columnIds.length) return [];
  const candidates = await sampleRows(db, columnIds, 10), selected: LanguageSample[] = [];
  let remaining = 12000;
  for (const sample of candidates) {
    const size = JSON.stringify(sample).length;
    if (Array.from(sample.spoken).length > 4000 || size > remaining) continue;
    selected.push(sample); remaining -= size;
    if (selected.length === 3) break;
  }
  return selected;
}

export async function languageSamples(input: unknown): Promise<LanguageSamplePage> {
  const query = z.object({ columnId: z.string().min(1).max(80).optional(), page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const where = query.columnId ? db`column_ids @> ${[query.columnId]}::text[]` : db`true`;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_language_samples WHERE ${where}`;
    return { rows: await sampleRows(db, query.columnId ? [query.columnId] : [], query.limit, (query.page - 1) * query.limit),
      total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
