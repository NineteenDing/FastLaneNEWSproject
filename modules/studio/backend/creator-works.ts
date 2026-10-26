import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { CreatorWork } from "../contracts.ts";

const materialId = z.string().regex(/^creator:/).transform(value => value.slice(8)).pipe(z.uuid());

/** Correlated only by the existing post UUID; no work metadata is added to old unlinked inputs. */
export function creatorWorkSource(db: Db, postId: ReturnType<Db>) {
  return db`coalesce((SELECT jsonb_build_object('work', jsonb_build_object('id', w.id, 'title', w.title, 'version', w.version,
    'publicationCount', (SELECT count(*)::int FROM studio_creator_work_posts WHERE work_id = w.id)))
    FROM studio_creator_work_posts member JOIN studio_creator_works w ON w.id = member.work_id WHERE member.post_id = ${postId}), '{}'::jsonb)`;
}

async function workDetails(db: Db, id: string): Promise<CreatorWork | null> {
  const [work] = await db<{ id: string; title: string; version: number }[]>`SELECT id, title, version FROM studio_creator_works WHERE id = ${id}`;
  if (!work) return null;
  const publications = await db<CreatorWork["publications"]>`SELECT 'creator:' || p.id AS id, p.content->>'title' AS title, p.content->>'url' AS url,
    c.platform, coalesce(p.content->>'kind', 'video') AS kind, coalesce(c.name, c.locator) AS "creatorName", p.content->>'publishedAt' AS "publishedAt", p.content->'metrics' AS metrics
    FROM studio_creator_work_posts member JOIN studio_creator_posts p ON p.id = member.post_id
    JOIN studio_creator_accounts c ON c.id = p.creator_id WHERE member.work_id = ${id} ORDER BY p.collected_at, p.id LIMIT 100`;
  return { ...work, publications };
}

export async function creatorWorkForMaterial(input: unknown) {
  const id = materialId.parse(input);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [post] = await db<{ work_id: string | null }[]>`SELECT member.work_id FROM studio_creator_posts p
      LEFT JOIN studio_creator_work_posts member ON member.post_id = p.id WHERE p.id = ${id}`;
    return post ? { work: post.work_id ? await workDetails(db, post.work_id) : null } : null;
  });
}

/** Replace only an explicitly selected work's membership. Never move a member from another work. */
export async function saveCreatorWork(id: string | null, input: unknown, actor: string) {
  if (id) z.uuid().parse(id);
  const value = z.object({ title: z.string().trim().min(1).max(200), version: z.number().int().positive().optional(),
    materialIds: z.array(materialId).min(id ? 0 : 2).max(100).refine(ids => new Set(ids).size === ids.length, "同一材料不能重复选择") }).strict()
    .refine(value => id ? value.version !== undefined : value.version === undefined, "请使用当前作品版本").parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const [before] = id ? await db<{ id: string; title: string; version: number }[]>`SELECT id, title, version FROM studio_creator_works WHERE id = ${id} FOR UPDATE` : [];
    if (id && !before) return null;
    if (before && before.version !== value.version) throw new Conflict("同作品关联已在其他窗口修改，请刷新后重试");
    const posts = await db<{ id: string }[]>`SELECT id FROM studio_creator_posts WHERE id = ANY(${value.materialIds}::uuid[]) ORDER BY id FOR UPDATE`;
    if (posts.length !== value.materialIds.length) throw new Conflict("部分作品尚未收录，未修改任何关联");
    const existing = await db<{ work_id: string }[]>`SELECT work_id FROM studio_creator_work_posts WHERE post_id = ANY(${value.materialIds}::uuid[])`;
    if (existing.some(member => member.work_id !== id)) throw new Conflict("所选材料已经关联其他作品，请先解除原关联");
    const workId = id ?? randomUUID(), version = (before?.version ?? 0) + 1;
    const oldMembers = before ? await db<{ post_id: string }[]>`SELECT post_id FROM studio_creator_work_posts WHERE work_id = ${workId}` : [];
    if (id) {
      await db`UPDATE studio_creator_works SET title = ${value.title}, version = ${version} WHERE id = ${id}`;
      await db`DELETE FROM studio_creator_work_posts WHERE work_id = ${id}`;
    } else await db`INSERT INTO studio_creator_works (id, title, version) VALUES (${workId}, ${value.title}, ${version})`;
    if (value.materialIds.length) await db`INSERT INTO studio_creator_work_posts ${db(value.materialIds.map(post_id => ({ post_id, work_id: workId })))}`;
    await audit(actor, "studio.creator.work", `creator-work:${workId}`, null,
      before ? { ...before, materialIds: oldMembers.map(row => 'creator:' + row.post_id) } : null,
      { title: value.title, version, materialIds: value.materialIds.map(id => 'creator:' + id) }, { db });
    return { work: (await workDetails(db, workId))! };
  });
}
