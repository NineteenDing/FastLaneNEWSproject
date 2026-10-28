import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { sha256 } from "@aihot/backend/lib/ids";
import { enabledWritingSkills } from "./writing-skills.ts";
import { attachWritingSourceImages, copyWritingImages, protectWritingImages } from "./writing-images.ts";
import { languageSamplesForWriting, recordLanguageSample } from "./language-samples.ts";
import { writingReferenceMaterials } from "./writing-reference-materials.ts";
import { freezeReferenceAnalysis } from "./reference-vision.ts";
import { frozenTopicHistory, historyQuoteAnchors, historySourceChanges } from "./topic-history.ts";
import { expressionLibrariesForWriting } from "./creator-expressions.ts";
import type { TopicColumn, TopicReview, WritingProject, WritingVersion, WritingContent } from "../contracts.ts";

const createInput = z.object({ requestId: z.uuid(), batchId: z.uuid(),
  referenceAnalysisId: z.uuid().optional(),
  directionIds: z.array(z.string().min(1).max(80)).min(1).max(6).refine(ids => new Set(ids).size === ids.length),
  title: z.string().trim().min(1).max(240).optional(), instructions: z.string().trim().max(5000).default(""),
  references: z.array(z.object({ materialId: z.string().min(1).max(150), role: z.enum(["fact", "expression", "counterpoint"]) }).strict()).max(50).optional(),
}).strict();
type Row = Omit<WritingProject, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
/** Model writes and restores record their rules; ordinary saves inherit the preceding context. */
function versionSkills(version?: number) {
  return sql`coalesce((SELECT rules.skills FROM studio_writing_versions rules WHERE rules.project_id = studio_writing_projects.id
    AND rules.version <= ${version ?? sql`studio_writing_projects.version`} AND rules.skills IS NOT NULL
    ORDER BY rules.version DESC LIMIT 1), studio_writing_projects.snapshot->'skills')`;
}
const columns = sql`id, batch_id AS "batchId", title, title_options AS "titleOptions", instructions, version::int, state, content,
  snapshot || jsonb_build_object('skills', ${versionSkills()}) AS snapshot, created_at AS "createdAt", updated_at AS "updatedAt"`;
function project(row: Row): WritingProject { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }

export async function createWritingProject(input: unknown, actor: string) {
  const value = createInput.parse(input), creationHash = sha256(JSON.stringify(value));
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`studio.writing.request:${value.requestId}`}, 0))`;
    const [existing] = await db<{ id: string; creation_hash: string }[]>`SELECT id, creation_hash FROM studio_writing_projects WHERE request_id = ${value.requestId}`;
    if (existing) {
      if (existing.creation_hash !== creationHash) throw new Conflict("这个创建请求已经使用，请重新创建独立稿件");
      return { id: existing.id };
    }
    const [batch] = await db<{ id: string; startsAt: Date; endsAt: Date; audience: string; columns: TopicColumn[]; output: TopicReview | null }[]>`
      SELECT b.id, b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.audience, b.columns, r.output FROM studio_topic_batches b
      LEFT JOIN studio_topic_reviews r ON r.batch_id = b.id AND r.state = 'completed' WHERE b.id = ${value.batchId}`;
    if (!batch?.output?.result) throw new Conflict("选题尚未完成审核，请先查看审核状态");
    const directions = value.directionIds.map(id => batch.output!.result!.directions.find(direction => direction.id === id));
    if (directions.some(direction => !direction)) throw new Conflict("选择的方向不在最终推荐中，请刷新选题");
    const selected = directions.filter(direction => !!direction);
    const references = value.references ?? selected.flatMap(direction => direction.references.map(ref => ({ materialId: ref.materialId, role: ref.role })));
    const ids = [...new Set(references.map(ref => ref.materialId))];
    const { materials, supplementalIds } = await writingReferenceMaterials(db, batch, ids);
    const referenceAnalysis = value.referenceAnalysisId ? await freezeReferenceAnalysis(db, value.referenceAnalysisId, batch.id, materials, references) : null;
    const frozenHistory = await frozenTopicHistory(db, value.batchId), history = frozenHistory?.items.filter(item => ids.includes(item.material.id));
    const expressionLibraries = await expressionLibrariesForWriting(materials, references, db);
    const snapshot: WritingProject["snapshot"] = { batch: { id: batch.id, startsAt: batch.startsAt.toISOString(), endsAt: batch.endsAt.toISOString() },
      audience: batch.audience, columns: batch.columns, directions: selected, materials,
      references, skills: await enabledWritingSkills(selected.map(direction => direction.columnId), db),
      ...(expressionLibraries.length ? { expressionLibraries } : {}),
      ...(referenceAnalysis ? { referenceAnalysis } : {}),
      ...(supplementalIds.length ? { supplementalMaterialIds: supplementalIds } : {}),
      ...(history?.length ? { history: { policy: frozenHistory!.policy, frozenAt: frozenHistory!.frozenAt,
        items: history.map(({ material, ...item }) => ({ ...item, materialId: material.id,
          anchors: historyQuoteAnchors(material, selected.flatMap(direction => direction.references.filter(ref => ref.materialId === material.id).map(ref => ref.quote))) })) } } : {}),
      languageSamples: await languageSamplesForWriting([...new Set(selected.map(direction => direction.columnId))], db), reviewVerdict: batch.output.verdict! };
    const id = randomUUID(), title = value.title ?? selected[0]!.titles[selected[0]!.preferredTitle]!;
    const titleOptions = [...new Set(selected.flatMap(direction => direction.titles).map(item => item.trim()).filter(item => item.length <= 240))];
    await db`INSERT INTO studio_writing_projects (id, request_id, creation_hash, batch_id, title, title_options, instructions, snapshot)
      VALUES (${id}, ${value.requestId}, ${creationHash}, ${value.batchId}, ${title}, ${db.json(titleOptions)}, ${value.instructions}, ${db.json(snapshot as never)})`;
    await attachWritingSourceImages(db, id, materials);
    await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source)
      SELECT id, version, title, title_options, instructions, content, 'created' FROM studio_writing_projects WHERE id = ${id}`;
    await audit(actor, "studio.writing.create", `draft:${id}`, null, null, { directionIds: value.directionIds, batchId: value.batchId }, { db });
    return { id };
  });
}

export async function writingProject(id: string) {
  z.uuid().parse(id);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [row] = await db<Row[]>`SELECT ${columns} FROM studio_writing_projects WHERE id = ${id}`;
    if (!row) return null;
    const history = row.snapshot.history;
    return { ...project(row), ...(history ? { historyChanges: await historySourceChanges(db, history.policy,
      history.items.map(item => ({ id: item.materialId, fingerprint: item.fingerprint }))) } : {}) };
  });
}

/** Copy the saved version, preserving its facts and rules without generating or confirming it. */
export async function copyWritingProject(id: string, input: unknown, actor: string) {
  z.uuid().parse(id);
  const value = z.object({ requestId: z.uuid(), version: z.number().int().positive() }).strict().parse(input);
  const creationHash = sha256(JSON.stringify({ operation: "copy", projectId: id, ...value }));
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`studio.writing.request:${value.requestId}`}, 0))`;
    const [existing] = await db<{ id: string; creation_hash: string }[]>`SELECT id, creation_hash FROM studio_writing_projects WHERE request_id = ${value.requestId}`;
    if (existing) {
      if (existing.creation_hash !== creationHash) throw new Conflict("这个复制请求已经使用，请重新确认要复制的稿件版本");
      return { id: existing.id };
    }
    const [source] = await db<Row[]>`SELECT ${columns} FROM studio_writing_projects WHERE id = ${id} FOR UPDATE`;
    if (!source) return null;
    if (source.version !== value.version) throw new Conflict("原稿已在其他窗口更新，请先对比最新版本后再复制");
    // The suffix fits the existing 240-code-unit title limit; do not split an emoji at the cut.
    const copiedId = randomUUID(), title = source.title.slice(0, 235).replace(/[\uD800-\uDBFF]$/, "") + " · 副本";
    const snapshot = { ...source.snapshot, copiedFrom: { projectId: id, version: source.version } };
    await db`INSERT INTO studio_writing_projects (id, request_id, creation_hash, batch_id, title, title_options, instructions, content, snapshot)
      VALUES (${copiedId}, ${value.requestId}, ${creationHash}, ${source.batchId}, ${title}, ${db.json(source.titleOptions ?? [])}, ${source.instructions}, ${db.json(source.content as never)}, ${db.json(snapshot as never)})`;
    await copyWritingImages(db, id, copiedId, source.content);
    await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source)
      SELECT id, version, title, title_options, instructions, content, 'created' FROM studio_writing_projects WHERE id = ${copiedId}`;
    await audit(actor, "studio.writing.copy", `draft:${copiedId}`, null, null, { projectId: id, version: source.version }, { db });
    return { id: copiedId };
  });
}

export async function saveWritingProject(id: string, input: unknown, actor: string) {
  z.uuid().parse(id);
  const value = z.object({ version: z.number().int().positive(), mode: z.enum(["manual", "auto"]).default("manual"),
    title: z.string().trim().min(1).max(240).optional(), instructions: z.string().trim().max(5000).optional(),
    titleOptions: z.array(z.string().trim().min(1).max(240)).max(30).refine(items => new Set(items).size === items.length).optional(),
    content: z.object({ spoken: z.string().max(200000), production: z.string().max(200000), notes: z.string().max(200000) }).strict().optional(),
  }).strict().parse(input);
  return sql.begin(async db => {
    const [row] = await db<Row[]>`SELECT ${columns} FROM studio_writing_projects WHERE id = ${id} FOR UPDATE`;
    if (!row) return null;
    if (row.version !== value.version) throw new Conflict("稿件已在其他窗口更新，请保留本地内容并对比最新版本");
    const title = value.title ?? row.title, instructions = value.instructions ?? row.instructions, content = value.content ?? row.content;
    const titleOptions = value.titleOptions ?? row.titleOptions ?? [];
    if (title === row.title && JSON.stringify(titleOptions) === JSON.stringify(row.titleOptions ?? []) && instructions === row.instructions && ["spoken", "production", "notes"].every(key => content[key as keyof typeof content] === row.content[key as keyof typeof content]))
      return project(row);
    await protectWritingImages(db, id, row.version + 1, content);
    const [saved] = await db<Row[]>`UPDATE studio_writing_projects SET title = ${title}, title_options = ${db.json(titleOptions)}, instructions = ${instructions}, content = ${db.json(content as never)},
      version = version + 1, state = 'draft', updated_at = now() WHERE id = ${id} RETURNING ${columns}`;
    await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source)
      VALUES (${id}, ${saved!.version}, ${title}, ${db.json(titleOptions)}, ${instructions}, ${db.json(content as never)}, ${value.mode})`;
    await audit(actor, "studio.writing.save", `draft:${id}`, null, null, { version: saved!.version, mode: value.mode }, { db });
    return project(saved!);
  });
}

export async function applyWritingGeneration(db: Tx, id: string, version: number, content: WritingContent, skills: WritingProject["snapshot"]["skills"], headings?: { title: string; titleOptions: string[] }) {
  const [saved] = await db`UPDATE studio_writing_projects SET content = ${db.json(content as never)},
    title = ${headings?.title ?? db`title`}, title_options = ${headings ? db.json(headings.titleOptions) : db`title_options`}, version = version + 1,
    state = 'draft', updated_at = now() WHERE id = ${id} AND version = ${version} RETURNING id`;
  if (!saved) return false;
  await protectWritingImages(db, id, version + 1, content);
  await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source, skills)
    SELECT id, version, title, title_options, instructions, content, 'model', ${db.json(skills as never)} FROM studio_writing_projects WHERE id = ${id}`;
  return true;
}

export async function writingVersion(id: string, version: unknown, db: typeof sql | Tx = sql): Promise<WritingVersion | null> {
  z.uuid().parse(id); const selected = z.coerce.number().int().positive().parse(version);
  const [row] = await db<Array<Omit<WritingVersion, "createdAt"> & { createdAt: Date }>>`SELECT v.version::int, v.title, coalesce(v.title_options, '[]'::jsonb) AS "titleOptions", v.instructions, v.content, v.source, v.created_at AS "createdAt",
    ${versionSkills(selected)} AS skills FROM studio_writing_versions v JOIN studio_writing_projects ON studio_writing_projects.id = v.project_id
    WHERE v.project_id = ${id} AND v.version = ${selected}`;
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
}

export async function changeWritingVersion(id: string, input: unknown, mode: "final" | "restore", actor: string, finalGallery?: string[]) {
  z.uuid().parse(id);
  const value = z.object({ version: z.number().int().positive(), ...(mode === "restore" ? { restoreVersion: z.number().int().positive() } : {}) }).strict().parse(input);
  return sql.begin(async db => {
    const [row] = await db<Row[]>`SELECT ${columns} FROM studio_writing_projects WHERE id = ${id} FOR UPDATE`;
    if (!row) return null;
    if (row.version !== value.version) throw new Conflict("稿件已更新，请先保存并对比最新版本");
    if (mode === "final" && !row.content.spoken.trim()) throw new Conflict("请先写入口播正文再确认定稿");
    if (mode === "final" && row.state === "final") { await recordLanguageSample(db, project(row)); return project(row); }
    const previous = mode === "restore" ? await writingVersion(id, value.restoreVersion, db) : null;
    if (mode === "restore" && !previous) throw new Conflict("要恢复的历史版本不存在");
    if (previous && !previous.skills) throw new Conflict("历史版本的写作规则无法读取，请保留当前稿件并检查历史记录");
    const source = previous ?? row;
    await protectWritingImages(db, id, row.version + 1, source.content, mode === "final" ? finalGallery ?? true : []);
    const [saved] = await db<Row[]>`UPDATE studio_writing_projects SET title = ${source.title}, title_options = ${db.json(source.titleOptions ?? [])}, instructions = ${source.instructions},
      content = ${db.json(source.content as never)}, version = version + 1, state = ${mode === "final" ? "final" : "draft"}, updated_at = now()
      WHERE id = ${id} RETURNING ${columns}`;
    await db`INSERT INTO studio_writing_versions (project_id, version, title, title_options, instructions, content, source, skills)
      SELECT id, version, title, title_options, instructions, content, ${mode}, ${previous ? db.json(previous.skills as never) : null} FROM studio_writing_projects WHERE id = ${id}`;
    // RETURNING ran before the restore's rule context was inserted above.
    if (previous) saved!.snapshot.skills = previous.skills!;
    if (mode === "final") await recordLanguageSample(db, project(saved!));
    await audit(actor, `studio.writing.${mode}`, `draft:${id}`, null, null, { version: saved!.version }, { db });
    return project(saved!);
  });
}

export async function writingVersions(id: string, input: unknown) {
  z.uuid().parse(id);
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [draft] = await db`SELECT id FROM studio_writing_projects WHERE id = ${id}`;
    if (!draft) return null;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_writing_versions WHERE project_id = ${id}`;
    const rows = await db<Array<{ version: number; title: string; source: WritingVersion["source"]; createdAt: Date }>>`
      SELECT version::int, title, source, created_at AS "createdAt" FROM studio_writing_versions WHERE project_id = ${id}
      ORDER BY version DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    return { rows: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), total, page: query.page, hasMore: query.page * query.limit < total };
  });
}

export async function writingProjects(input: unknown) {
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
    batchId: z.uuid().optional(), periodStart: z.iso.datetime().optional(), state: z.enum(["all", "draft", "final"]).default("all"), columnId: z.string().min(1).max(80).optional(), q: z.string().trim().max(200).default("") }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    const where = db`(${query.batchId ?? null}::uuid IS NULL OR batch_id = ${query.batchId ?? null}::uuid)
      AND (${query.periodStart ?? null}::timestamptz IS NULL OR batch_id IN (SELECT id FROM studio_topic_batches WHERE starts_at = ${query.periodStart ?? null}::timestamptz))
      AND ${query.state === "final" ? db`EXISTS (SELECT 1 FROM studio_language_samples s WHERE s.project_id = studio_writing_projects.id)` : query.state === "draft" ? db`state = 'draft'` : db`true`}
      AND ${query.columnId ? db`EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'directions') direction WHERE direction->>'columnId' = ${query.columnId})` : db`true`}
      AND ${query.q ? db`(title ILIKE ${pattern} OR content::text ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'materials') material WHERE material->>'title' ILIKE ${pattern} OR material->'source'->>'name' ILIKE ${pattern}))` : db`true`}`;
    const [{ total }] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_writing_projects WHERE ${where}`;
    const rows = await db<Row[]>`SELECT ${columns},
      (SELECT s.version::int FROM studio_language_samples s WHERE s.project_id = studio_writing_projects.id) AS "confirmedVersion",
      (SELECT v.title FROM studio_language_samples s JOIN studio_writing_versions v ON v.project_id = s.project_id AND v.version = s.version
        WHERE s.project_id = studio_writing_projects.id) AS "confirmedTitle" FROM studio_writing_projects WHERE ${where}
      ORDER BY updated_at DESC, id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`;
    return { rows: rows.map(project), total, page: query.page, hasMore: query.page * query.limit < total };
  });
}
