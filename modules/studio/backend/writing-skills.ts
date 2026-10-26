import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { currentColumns } from "./topic-columns.ts";
import type { WritingProject, WritingSkill, WritingSkillVersionPage } from "../contracts.ts";

const builtins = new Map<string, WritingSkill>([
  { id: "humanizer-zh", name: "Humanizer 中文去 AI 味", priority: 0 },
  { id: "dbskill-spoken", name: "dbskill 口播衔接与标题", priority: 20 },
].map(({ id, name, priority }) => [id, { id, name, priority, version: 1, enabled: true, columnIds: [], builtin: true, createdAt: null,
  body: readFileSync(new URL(`../vendor/${id}/SKILL.md`, import.meta.url), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() }]));
const fields = z.object({ name: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(50000),
  enabled: z.boolean().default(true), priority: z.number().int().min(0).max(1000).default(100),
  columnIds: z.array(z.string().min(1).max(80)).max(30).refine(ids => new Set(ids).size === ids.length).default([]),
}).strict();
const patchFields = fields.partial().extend({ version: z.number().int().positive(),
  enabled: fields.shape.enabled.unwrap().optional(), priority: fields.shape.priority.unwrap().optional(), columnIds: fields.shape.columnIds.unwrap().optional(),
}).strict();

type SavedSkill = { id: string; version: number; config: z.infer<typeof fields>; created_at: Date };
function skillFromRow(row: SavedSkill): WritingSkill {
  return { ...fields.parse(row.config), id: row.id, version: row.version, builtin: builtins.has(row.id), createdAt: row.created_at.toISOString() };
}
function validateId(id: string) { if (!builtins.has(id)) z.uuid().parse(id); }

async function current(db: typeof sql | Tx) {
  const rows = await db<SavedSkill[]>`
    SELECT DISTINCT ON (id) id, version, config, created_at FROM studio_writing_skills ORDER BY id, version DESC`;
  const merged = new Map(builtins);
  for (const row of rows) merged.set(row.id, skillFromRow(row));
  return [...merged.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}
export { current as currentWritingSkills };
export async function writingSkills() { return { rows: await current(sql) }; }

export async function writingSkillVersions(id: string, input: unknown): Promise<WritingSkillVersionPage | null> {
  validateId(id);
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(30).default(10) }).strict().parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [count] = await db<{ total: number; latest: number | null; hasFirst: boolean | null }[]>`
      SELECT count(*)::int AS total, max(version)::int AS latest, bool_or(version = 1) AS "hasFirst"
      FROM studio_writing_skills WHERE id = ${id}`;
    const builtin = builtins.get(id), virtualFirst = !!builtin && !count!.hasFirst;
    const total = count!.total + Number(virtualFirst);
    if (!total) return null;
    const offset = (query.page - 1) * query.limit;
    const saved = await db<SavedSkill[]>`SELECT id, version, config, created_at FROM studio_writing_skills
      WHERE id = ${id} ORDER BY version DESC LIMIT ${query.limit} OFFSET ${offset}`;
    const rows = saved.map(skillFromRow);
    if (virtualFirst && offset <= count!.total && offset + query.limit > count!.total) rows.push(builtin!);
    return { rows, total, page: query.page, hasMore: query.page * query.limit < total, currentVersion: count!.latest ?? 1 };
  });
}

export async function writingSkillVersion(id: string, version: unknown) {
  validateId(id); const number = z.coerce.number().int().positive().parse(version);
  const [row] = await sql<SavedSkill[]>`SELECT id, version, config, created_at FROM studio_writing_skills WHERE id = ${id} AND version = ${number}`;
  return row ? skillFromRow(row) : number === 1 ? builtins.get(id) ?? null : null;
}

export async function enabledWritingSkills(columnIds: string[], db: typeof sql | Tx): Promise<WritingProject["snapshot"]["skills"]> {
  return (await current(db)).filter(skill => skill.enabled && (!skill.columnIds.length || skill.columnIds.some(id => columnIds.includes(id))))
    .map(skill => ({ id: skill.id, version: String(skill.version), name: skill.name, body: skill.body }));
}

export async function restoreWritingSkill(id: string, input: unknown, actor: string) {
  validateId(id);
  const value = z.object({ version: z.number().int().positive(), sourceVersion: z.number().int().positive() }).strict().parse(input);
  const source = await writingSkillVersion(id, value.sourceVersion);
  if (!source) return null;
  const { name, body, enabled, priority, columnIds } = source;
  return saveWritingSkill(id, { version: value.version, name, body, enabled, priority, columnIds }, actor, value.sourceVersion);
}

export async function saveWritingSkill(id: string | null, input: unknown, actor: string, restoredFrom?: number) {
  return sql.begin(db => appendWritingSkill(db, id, input, actor, restoredFrom));
}

/** Share the owning module's CAS/validation/audit with atomic learning activation. */
export async function appendWritingSkill(db: Tx, id: string | null, input: unknown, actor: string, restoredFrom?: number) {
  if (id !== null) validateId(id);
  const value = id === null ? fields.parse(input) : patchFields.parse(input);
  await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.writing.skills', 0))`;
  const previous = id ? (await current(db)).find(skill => skill.id === id) : null;
  if (id && !previous) return null;
  if (previous && (!('version' in value) || value.version !== previous.version)) throw new Conflict("写作规则已更新，请刷新后再保存");
  const config = fields.parse({ name: previous?.name, body: previous?.body, enabled: previous?.enabled, priority: previous?.priority, columnIds: previous?.columnIds,
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version")) });
  const columns = await currentColumns(db);
  if (config.columnIds.some(columnId => !columns.some(column => column.id === columnId))) throw new Conflict("适用栏目不存在，请刷新栏目列表");
  const skillId = id ?? randomUUID(), version = previous ? previous.version + 1 : 1;
  const [saved] = await db<{ created_at: Date }[]>`INSERT INTO studio_writing_skills (id, version, config) VALUES (${skillId}, ${version}, ${db.json(config)}) RETURNING created_at`;
  await audit(actor, restoredFrom === undefined ? "studio.writing.skill.save" : "studio.writing.skill.restore", `skill:${skillId}`, null, null,
    { version, enabled: config.enabled, columnIds: config.columnIds, ...(restoredFrom === undefined ? {} : { restoredFrom }) }, { db });
  return { ...config, id: skillId, version, builtin: builtins.has(skillId), createdAt: saved!.created_at.toISOString() } satisfies WritingSkill;
}
