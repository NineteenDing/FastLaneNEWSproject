import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { CreatorAccount, CreatorAccounts } from "../contracts.ts";
import { resolveCreatorLink } from "./creator-links.ts";
import { mediaCreatorPlatforms } from "./mediacrawler.ts";
import { canonicalCreatorId } from "./creator-identity.ts";

type Row = Omit<CreatorAccount, "addedAt" | "latestPublishedAt" | "lastCheckedAt" | "avatarUrl" | "collectionSupported"> & {
  addedAt: Date; latestPublishedAt: Date | null; lastCheckedAt: Date | null;
  avatarUrl: string | null;
};
const fields = sql`id, platform, locator, homepage, name, description, follower_count::float8 AS "followerCount",
  work_count::float8 AS "workCount", latest_published_at AS "latestPublishedAt", last_checked_at AS "lastCheckedAt",
  profile_state AS "profileState", enabled, archived, added_at AS "addedAt", version,
  (SELECT jsonb_build_object('stableId', i.stable_id, 'aliases', (SELECT coalesce(jsonb_agg(alias.locator ORDER BY alias.locator), '[]'::jsonb)
    FROM (SELECT locator FROM studio_creator_aliases WHERE creator_id = i.creator_id ORDER BY locator LIMIT 20) alias))
    FROM studio_creator_identities i WHERE i.creator_id = studio_creator_accounts.id) AS identity,
  (SELECT jsonb_build_object('id', s.id, 'name', s.name) FROM studio_creator_subject_accounts member
    JOIN studio_creator_subjects s ON s.id = member.subject_id WHERE member.account_id = studio_creator_accounts.id) AS subject,
  (SELECT '/api/admin/studio/creators/' || studio_creator_accounts.id || '/avatar?v=' || image_id
    FROM studio_image_references WHERE owner = 'creator-avatar:' || studio_creator_accounts.id LIMIT 1) AS "avatarUrl",
  (SELECT count(*)::int FROM studio_creator_posts WHERE creator_id = studio_creator_accounts.id) AS "collectedCount",
  COALESCE((SELECT state FROM studio_creator_collection WHERE creator_id = studio_creator_accounts.id), 'not_connected') AS "collectionState",
  (SELECT coverage FROM studio_creator_collection WHERE creator_id = studio_creator_accounts.id) AS "collectionCoverage"`;
function card(row: Row): CreatorAccount {
  return { ...row, addedAt: row.addedAt.toISOString(), latestPublishedAt: row.latestPublishedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    collectionSupported: mediaCreatorPlatforms.some(p => p === row.platform),
    collectionCoverage: row.collectionCoverage ? { page: row.collectionCoverage.page, nextPage: row.collectionCoverage.nextPage, complete: row.collectionCoverage.complete } : null };
}

export async function creatorAccount(id: string) {
  z.uuid().parse(id);
  const canonical = await canonicalCreatorId(id);
  const [row] = canonical ? await sql<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE id = ${canonical}` : [];
  return row ? card(row) : null;
}

export async function followCreator(input: unknown, actor: string) {
  const link = await resolveCreatorLink(z.object({ url: z.string() }).strict().parse(input).url);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const [alias] = await tx<{ id: string; following: boolean }[]>`SELECT alias.creator_id AS id, c.following FROM studio_creator_aliases alias
      JOIN studio_creator_accounts c ON c.id = alias.creator_id WHERE alias.platform = ${link.platform} AND alias.locator = ${link.locator}`;
    if (alias) {
      const [known] = await tx<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE id = ${alias.id} FOR UPDATE`;
      if (!alias.following) {
        const [restored] = await tx<Row[]>`UPDATE studio_creator_accounts SET following = true, enabled = true, added_at = now(), version = version + 1
          WHERE id = ${alias.id} RETURNING ${fields}`;
        await audit(actor, "studio.creator.follow", `creator:${alias.id}`, null, null, { platform: link.platform, homepage: link.homepage }, { db: tx });
        return { created: true, creator: card(restored!) };
      }
      return { created: false, creator: card(known!) };
    }
    const inserted = await tx<Row[]>`INSERT INTO studio_creator_accounts (id, platform, locator, homepage, collector_context)
      VALUES (${randomUUID()}, ${link.platform}, ${link.locator}, ${link.homepage}, ${tx.json(link.context)})
      ON CONFLICT (platform, locator) DO UPDATE SET following = true, enabled = true, added_at = now(),
        collector_context = EXCLUDED.collector_context, version = studio_creator_accounts.version + 1
        WHERE NOT studio_creator_accounts.following RETURNING ${fields}`;
    const row = inserted[0] ?? (await tx<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE platform = ${link.platform} AND locator = ${link.locator}`)[0]!;
    if (inserted.length) await audit(actor, "studio.creator.follow", `creator:${row.id}`, null, null, { platform: row.platform, homepage: row.homepage }, { db: tx });
    return { created: inserted.length > 0, creator: card(row) };
  });
}

export async function creatorAccounts(query: unknown): Promise<CreatorAccounts> {
  const f = z.object({ q: z.string().trim().max(200).default(""), page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(24), archived: z.enum(["true", "false"]).default("false"),
    enabled: z.enum(["true", "false"]).optional(), platform: z.enum(["xhs", "douyin", "kuaishou", "bilibili", "weibo", "tieba", "zhihu"]).optional() }).strict().parse(query);
  const pattern = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
  return sql.begin("isolation level repeatable read read only", async tx => {
    const where = tx`following AND archived = ${f.archived === "true"} AND (name ILIKE ${pattern} OR locator ILIKE ${pattern} OR homepage ILIKE ${pattern})
      AND (${f.enabled ?? null}::text IS NULL OR enabled = ${f.enabled === "true"})
      AND (${f.platform ?? null}::text IS NULL OR platform = ${f.platform ?? null})`;
    const [{ total }] = await tx<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_creator_accounts WHERE ${where}`;
    const rows = await tx<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE ${where} ORDER BY added_at DESC, id LIMIT ${f.limit} OFFSET ${(f.page - 1) * f.limit}`;
    return { rows: rows.map(card), total, page: f.page, hasMore: f.page * f.limit < total };
  });
}

export async function updateCreator(id: string, input: unknown, actor: string, transaction?: Tx) {
  z.uuid().parse(id);
  const status = z.union([
    z.object({ version: z.number().int().positive(), enabled: z.boolean() }).strict(),
    z.object({ version: z.number().int().positive(), archived: z.boolean() }).strict(),
  ]).parse(input);
  const persist = async (tx: Tx) => {
    const [before] = await tx<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE id = ${id} AND following FOR UPDATE`;
    if (!before) return null;
    if (before.version !== status.version) throw new Conflict("博主关注已被其他窗口修改，请刷新后重试");
    if ("enabled" in status && before.archived) throw new Conflict("请先恢复已移除的博主，再启用关注");
    const archived = "archived" in status ? status.archived : before.archived;
    const enabled = "archived" in status ? false : status.enabled;
    const [row] = await tx<Row[]>`UPDATE studio_creator_accounts SET archived = ${archived}, enabled = ${enabled}, version = version + 1 WHERE id = ${id} RETURNING ${fields}`;
    await audit(actor, "studio.creator.status", `creator:${id}`, null,
      { enabled: before.enabled, archived: before.archived }, { enabled, archived }, { db: tx });
    return { creator: card(row!) };
  };
  return transaction ? persist(transaction) : sql.begin(persist);
}

export async function updateCreators(input: unknown, actor: string) {
  const accounts = z.array(z.object({ id: z.uuid(), version: z.number().int().positive() }).strict()).min(1).max(100)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "同一博主不能重复选择");
  const value = z.union([
    z.object({ accounts, enabled: z.boolean() }).strict(),
    z.object({ accounts, archived: z.boolean() }).strict(),
  ]).parse(input);
  return sql.begin(async tx => {
    const creators = [];
    // Stable lock order makes concurrent overlapping batches safe; one conflict rolls back all changes and audits.
    for (const account of [...value.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
      const result = await updateCreator(account.id, { version: account.version, ...("enabled" in value ? { enabled: value.enabled } : { archived: value.archived }) }, actor, tx);
      if (!result) throw new Conflict("所选博主已改变，请刷新列表后重试，整批尚未修改");
      creators.push(result.creator);
    }
    return { creators };
  });
}

/** A person is only shared after explicit confirmation; equal nicknames never establish identity. */
export async function creatorSubjects(input: unknown) {
  const { q } = z.object({ q: z.string().trim().max(100).default("") }).strict().parse(input);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await sql`SELECT s.id, s.name, count(member.account_id)::int AS "accountCount"
    FROM studio_creator_subjects s JOIN studio_creator_subject_accounts member ON member.subject_id = s.id
    JOIN studio_creator_accounts account ON account.id = member.account_id AND account.following
    WHERE s.name ILIKE ${pattern} GROUP BY s.id ORDER BY s.created_at DESC, s.id LIMIT 50`;
  return { rows };
}

export async function linkCreatorSubject(input: unknown, actor: string) {
  const accounts = z.array(z.object({ id: z.uuid(), version: z.number().int().positive() }).strict()).min(1).max(100)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "同一账号不能重复选择");
  const value = z.union([
    z.object({ accounts, name: z.string().trim().min(1).max(100) }).strict(),
    z.object({ accounts, subjectId: z.uuid().nullable() }).strict(),
  ]).parse(input);
  return sql.begin(async tx => {
    // Match status batches' lock order. A stale account rolls back the entire membership change.
    const before: Row[] = [];
    for (const account of [...value.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await tx<Row[]>`SELECT ${fields} FROM studio_creator_accounts WHERE id = ${account.id} AND following FOR UPDATE`;
      if (!row || row.version !== account.version) throw new Conflict("所选博主已改变，请刷新后重试，关联尚未修改");
      before.push(row);
    }
    let subjectId: string | null;
    if ("name" in value) {
      subjectId = randomUUID();
      await tx`INSERT INTO studio_creator_subjects (id, name) VALUES (${subjectId}, ${value.name})`;
    } else {
      subjectId = value.subjectId;
      if (subjectId && !(await tx`SELECT id FROM studio_creator_subjects WHERE id = ${subjectId}`).length)
        throw new Conflict("这个博主主体已不可用，请重新选择");
    }
    const creators: CreatorAccount[] = [];
    for (const row of before) {
      if (subjectId) await tx`INSERT INTO studio_creator_subject_accounts (account_id, subject_id) VALUES (${row.id}, ${subjectId})
        ON CONFLICT (account_id) DO UPDATE SET subject_id = EXCLUDED.subject_id`;
      else await tx`DELETE FROM studio_creator_subject_accounts WHERE account_id = ${row.id}`;
      const [updated] = await tx<Row[]>`UPDATE studio_creator_accounts SET version = version + 1 WHERE id = ${row.id} RETURNING ${fields}`;
      await audit(actor, "studio.creator.subject", `creator:${row.id}`, null, { subject: row.subject }, { subject: updated!.subject }, { db: tx });
      creators.push(card(updated!));
    }
    return { creators };
  });
}
