import { sql, type Db, type Tx } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { creatorLink } from "./creator-links.ts";
import type { MediaCreatorResult } from "./mediacrawler.ts";

export async function canonicalCreatorId(id: string, db: Db = sql): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`SELECT coalesce(alias.creator_id, c.id) AS id FROM studio_creator_accounts c
    LEFT JOIN studio_creator_aliases alias ON alias.platform = c.platform AND alias.locator = c.locator WHERE c.id = ${id}`;
  return row?.id ?? null;
}

/** Caller holds studio-topic-media; match the UUID order used by batch account edits. */
export async function lockCreatorIdentity(db: Tx, id: string, platform: string, profile: MediaCreatorResult["profile"]) {
  if (platform !== "zhihu" || !profile.stableId) return { id, verified: false };
  const [own] = await db<{ stable_id: string }[]>`SELECT stable_id FROM studio_creator_identities WHERE creator_id = ${id}`;
  if (own && own.stable_id !== profile.stableId) throw new Conflict("平台账号身份与已确认记录不同，原内容已保留");
  const [known] = await db<{ id: string }[]>`SELECT creator_id AS id FROM studio_creator_identities WHERE platform = ${platform} AND stable_id = ${profile.stableId}`;
  const target = known?.id ?? id;
  await db`SELECT id FROM studio_creator_accounts WHERE id = ANY(${[id, target]}::uuid[]) ORDER BY id FOR UPDATE`;
  return { id: target, verified: true };
}

/** No historical account/post is deleted. Frozen evidence retains the original UUID and text. */
export async function bindCreatorIdentity(db: Tx, originalId: string, target: { id: string; verified: boolean }, profile: MediaCreatorResult["profile"]) {
  if (!target.verified) return { id: originalId, accept: true };
  const [original] = await db<{ locator: string; following: boolean; enabled: boolean }[]>`SELECT locator, following, enabled FROM studio_creator_accounts WHERE id = ${originalId}`;
  const [canonical] = await db<{ locator: string; following: boolean; enabled: boolean; archived: boolean }[]>`SELECT locator, following, enabled, archived FROM studio_creator_accounts WHERE id = ${target.id}`;
  if (!original || !canonical) throw new Conflict("账号资料已改变，请重新读取");
  const locator = profile.canonicalLocator ?? profile.externalId;
  const homepage = creatorLink(`https://www.zhihu.com/people/${locator}`).homepage;
  await db`INSERT INTO studio_creator_identities (platform, stable_id, creator_id) VALUES ('zhihu', ${profile.stableId!}, ${target.id})
    ON CONFLICT (platform, stable_id) DO NOTHING`;
  for (const alias of new Set([original.locator, canonical.locator, profile.externalId, locator])) {
    const [existing] = await db<{ creator_id: string }[]>`SELECT creator_id FROM studio_creator_aliases WHERE platform = 'zhihu' AND locator = ${alias}`;
    if (existing && existing.creator_id !== originalId && existing.creator_id !== target.id) throw new Conflict("该主页地址属于另一个已确认账号，未合并任何内容");
    await db`INSERT INTO studio_creator_aliases (platform, locator, creator_id) VALUES ('zhihu', ${alias}, ${target.id})
      ON CONFLICT (platform, locator) DO UPDATE SET creator_id = EXCLUDED.creator_id`;
  }
  if (originalId !== target.id) {
    // Preserve explicit grouping when the canonical account has none; never replace its existing choice.
    await db`INSERT INTO studio_creator_subject_accounts (account_id, subject_id)
      SELECT ${target.id}::uuid, subject_id FROM studio_creator_subject_accounts WHERE account_id = ${originalId}
      ON CONFLICT (account_id) DO NOTHING`;
    await db`UPDATE studio_creator_aliases SET creator_id = ${target.id} WHERE creator_id = ${originalId}`;
    // Preserve post UUIDs. Exact work duplicates stay readable by their old ID, but leave current lists.
    await db`UPDATE studio_creator_posts old SET creator_id = ${target.id} WHERE old.creator_id = ${originalId}
      AND NOT EXISTS (SELECT 1 FROM studio_creator_posts current WHERE current.creator_id = ${target.id} AND current.external_id = old.external_id)`;
    await db`UPDATE studio_creator_accounts SET following = false, enabled = false, version = version + 1 WHERE id = ${originalId}`;
  }
  const following = canonical.following || original.following;
  const enabled = canonical.following ? canonical.enabled : original.enabled;
  const archived = canonical.following ? canonical.archived : false;
  await db`UPDATE studio_creator_accounts SET homepage = ${homepage}, collector_context = collector_context || ${db.json({ profileLocator: locator })},
    following = ${following}, enabled = ${enabled}, archived = ${archived}, version = version + 1 WHERE id = ${target.id}`;
  return { id: target.id, accept: following && enabled && !archived };
}

/** SQL callers use p for a post and c for its original account. Explicit old-ID reads bypass this. */
export function visibleCreatorPost(db: Db) {
  return db`NOT EXISTS (SELECT 1 FROM studio_creator_aliases alias JOIN studio_creator_posts current
    ON current.creator_id = alias.creator_id AND current.external_id = p.external_id
    WHERE alias.platform = c.platform AND alias.locator = c.locator AND alias.creator_id <> p.creator_id)`;
}
