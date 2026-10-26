import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { Conflict, audit } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "./collection-admission.ts";
import { collectMediaCreator, MediaCrawlerFailure, mediaCreatorPlatforms } from "./mediacrawler.ts";
import { platformSessionSecret, platformSessionUnchanged } from "./platform-sessions.ts";
import type { CreatorPlatform } from "../contracts.ts";
import { saveCreatorContent } from "./creator-content.ts";
import { prepareCreatorAvatar } from "./creator-avatar.ts";
import { createImageAssets } from "./image-assets.ts";
import { bindCreatorIdentity, canonicalCreatorId, lockCreatorIdentity } from "./creator-identity.ts";

import { collectionEnabled } from "@aihot/backend/operations/collection-control";
export const creatorsCollecting = collectionEnabled;

/** Durable serial queue + original resource admission, shared by the connected platform adapters. */
export const creatorQueue = defineQueue<{ creatorId: string }>({
  name: "studio.creator.collect",
  executionGroup: "studio-creator-media",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission({ heavy: true, enabled: creatorsCollecting }),
  async run(jobs) {
    const results = [];
    for (const job of jobs) {
      if (!creatorsCollecting()) throw new QueueDeferred("采集已暂停");
      results.push(await collect(job.creatorId));
    }
    return results;
  },
});

export async function enqueueCreator(id: string, actor: string) {
  z.uuid().parse(id);
  const [creator] = await sql<{ platform: string; enabled: boolean; archived: boolean }[]>`SELECT platform, enabled, archived FROM studio_creator_accounts WHERE id = ${id} AND following`;
  if (!creator) return null;
  if (!creatorsCollecting()) throw new Conflict("采集开关尚未启用，当前未提交采集任务");
  if (creator.archived || !creator.enabled) throw new Conflict("请先恢复并启用这个博主");
  if (!mediaCreatorPlatforms.some(p => p === creator.platform)) throw new Conflict("此平台的MediaCrawler适配尚在接入，不能开始采集");
  const jobId = await enqueueOn(creatorQueue, { creatorId: id }, { singletonKey: id, group: { id: "creator-media" } });
  if (jobId) await audit(actor, "studio.creator.collect", `creator:${id}`, null, null, { queued: true });
  return { queued: !!jobId };
}

async function collect(id: string) {
  const token = randomUUID();
  const claim = await sql.begin(async tx => {
    const [account] = await tx<{ id: string; platform: CreatorPlatform; locator: string; version: number; collector_context: Record<string, string> }[]>`SELECT id, platform, locator, version, collector_context FROM studio_creator_accounts WHERE id = ${id} AND following AND enabled AND NOT archived FOR UPDATE`;
    if (!account || !mediaCreatorPlatforms.some(p => p === account.platform)) return null;
    const [lease] = await tx<{ next_page: number; next_cursor: string }[]>`INSERT INTO studio_creator_collection (creator_id, run_token, state) VALUES (${id}, ${token}, 'running')
      ON CONFLICT (creator_id) DO UPDATE SET run_token = EXCLUDED.run_token, state = 'running', started_at = now(), completed_at = NULL, error_code = NULL
      WHERE studio_creator_collection.state <> 'running' OR studio_creator_collection.started_at < now() - interval '5 minutes'
      RETURNING next_page, next_cursor`;
    return lease ? { ...account, page: lease.next_page, cursor: lease.next_cursor } : null;
  });
  if (!claim) return { state: "skipped" };
  let sessionVersion: number | null = null;
  async function interrupted(tx: Tx) {
    const [account] = await tx<{ version: number; enabled: boolean; archived: boolean }[]>`SELECT version, enabled, archived FROM studio_creator_accounts WHERE id = ${id} FOR UPDATE`;
    const [lease] = await tx`SELECT creator_id FROM studio_creator_collection WHERE creator_id = ${id} AND run_token = ${token} FOR UPDATE`;
    if (!lease) return { state: "superseded" };
    if (!account?.enabled || account.archived || account.version !== claim!.version || !creatorsCollecting()
      || sessionVersion !== null && !await platformSessionUnchanged(tx, claim!.platform, sessionVersion)) {
      await tx`UPDATE studio_creator_collection SET state = 'interrupted', completed_at = now(), next_check_at = now(), error_code = NULL WHERE creator_id = ${id} AND run_token = ${token}`;
      return { state: "interrupted" };
    }
    return null;
  }
  try {
    const session = await platformSessionSecret(claim.platform);
    sessionVersion = session.version;
    if (!session.readable) throw new MediaCrawlerFailure("login_required");
    const { profileLocator, ...context } = claim.collector_context;
    const locator = profileLocator ?? claim.locator;
    const result = await collectMediaCreator({ platform: claim.platform, locator, page: claim.page,
      cursor: claim.cursor, cookie: session.cookie, context });
    if (result.profile.externalId !== locator) throw new Error("平台返回了其他账号");
    const avatar = await prepareCreatorAvatar(result.profile.avatar);
    return await sql.begin(async tx => {
      // Freeze and video+job publication must see either the entire collection commit or none of it.
      await tx`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
      const identity = await lockCreatorIdentity(tx, id, claim.platform, result.profile);
      const stopped = await interrupted(tx);
      if (stopped) return stopped;
      const target = await bindCreatorIdentity(tx, id, identity, result.profile);
      if (!target.accept) {
        await tx`UPDATE studio_creator_collection SET state = 'interrupted', completed_at = now() WHERE creator_id = ${id} AND run_token = ${token}`;
        return { state: "interrupted" };
      }
      const accountId = target.id;
      if (avatar) {
        const assets = createImageAssets();
        // Evidence stores the versioned URL. Preserve these small, quota-accounted images for old snapshots.
        await assets.setReferences(`creator-avatar:${accountId}:${avatar}`, [avatar], tx);
        // Upgrades may have only the old mutable reference. Preserve its actual image before replacing it.
        // setReferences above holds the shared asset lock; no cleanup can race this copy.
        await tx`INSERT INTO studio_image_references (owner, image_id)
          SELECT 'creator-avatar:' || ${accountId} || ':' || image_id, image_id
          FROM studio_image_references WHERE owner = ${`creator-avatar:${accountId}`} ON CONFLICT DO NOTHING`;
        await assets.setReferences(`creator-avatar:${accountId}`, [avatar], tx);
      }
      for (const post of result.posts) {
        await saveCreatorContent(tx, accountId, claim.platform, post);
      }
      const dates = result.posts.map(p => p.publishedAt).filter((d): d is string => d !== null).sort();
      await tx`UPDATE studio_creator_accounts SET name = ${result.profile.name}, description = ${result.profile.description}, work_count = ${result.profile.workCount},
        follower_count = ${result.profile.followerCount}, profile_state = 'ready', last_checked_at = now(),
        latest_published_at = GREATEST(latest_published_at, ${dates.at(-1) ?? null}::timestamptz), version = version + 1 WHERE id = ${accountId}`;
      if (accountId !== id) {
        await tx`INSERT INTO studio_creator_collection (creator_id, run_token, state) VALUES (${accountId}, ${token}, 'running')
          ON CONFLICT (creator_id) DO UPDATE SET run_token = EXCLUDED.run_token, state = 'running', started_at = now()`;
        await tx`UPDATE studio_creator_collection SET state = 'interrupted', completed_at = now() WHERE creator_id = ${id} AND run_token = ${token}`;
      }
      await tx`UPDATE studio_creator_collection SET state = 'ready', completed_at = now(), next_page = ${result.coverage.nextPage ?? 1},
        next_cursor = ${result.coverage.nextCursor ?? ""}, coverage = ${tx.json(result.coverage)},
        next_check_at = now() + ${result.coverage.complete ? 45 : 1} * interval '1 minute' WHERE creator_id = ${accountId} AND run_token = ${token}`;
      return { state: "ready", received: result.posts.length, coverage: result.coverage };
    });
  } catch (error) {
    const code = error instanceof MediaCrawlerFailure ? error.code : "platform_failed";
    const stopped = await sql.begin(async tx => {
      const stopped = await interrupted(tx);
      if (stopped) return stopped;
      await tx`UPDATE studio_creator_collection SET state = ${code === "platform_failed" ? "failed" : code}, completed_at = now(), next_check_at = now() + interval '30 minutes', error_code = ${code}
        WHERE creator_id = ${id} AND run_token = ${token}`;
      return null;
    });
    if (stopped) return stopped;
    throw new Error("博主采集未完成，已保留之前成功收录的资料；请检查网络、平台会话或限流状态");
  }
}

export async function creatorContents(id: string, input: unknown) {
  z.uuid().parse(id);
  const canonical = await canonicalCreatorId(id); if (!canonical) return null; id = canonical;
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(input);
  const [creator] = await sql`SELECT id FROM studio_creator_accounts WHERE id = ${id}`;
  if (!creator) return null;
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [{ total }] = await tx<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_creator_posts WHERE creator_id = ${id}`;
    const posts = await tx`SELECT id, content - 'media' AS content, collected_at, updated_at FROM studio_creator_posts WHERE creator_id = ${id} ORDER BY collected_at DESC, id LIMIT 30 OFFSET ${(query.page - 1) * 30}`;
    const rows = [];
    for (const post of posts) {
      const observations = await tx`SELECT observed_at AS "observedAt", metrics FROM (
        SELECT id, observed_at, metrics FROM studio_creator_observations WHERE post_id = ${post.id} ORDER BY observed_at DESC, id DESC LIMIT 100
      ) recent ORDER BY observed_at, id`;
      rows.push({ id: post.id, ...post.content, collectedAt: post.collected_at.toISOString(), updatedAt: post.updated_at.toISOString(),
        observations: observations.map(o => ({ ...o, observedAt: o.observedAt.toISOString() })) });
    }
    return { rows, total, page: query.page, hasMore: query.page * 30 < total };
  });
}

export async function scheduleCreators() {
  if (!creatorsCollecting()) return { queued: 0 };
  const renewed = sql`c.state = 'login_required' AND login.sealed_cookie IS NOT NULL AND login.updated_at > c.completed_at`;
  const accounts = await sql<{ id: string }[]>`SELECT a.id FROM studio_creator_accounts a LEFT JOIN studio_creator_collection c ON c.creator_id = a.id
    LEFT JOIN studio_platform_sessions login ON login.platform = a.platform
    WHERE a.following AND a.enabled AND NOT a.archived AND a.platform = ANY(${[...mediaCreatorPlatforms]}::text[])
      AND (c.creator_id IS NULL OR c.next_check_at <= now() OR (${renewed})) AND (c.state IS DISTINCT FROM 'login_required' OR (${renewed}))
      AND (c.state IS DISTINCT FROM 'running' OR c.started_at < now() - interval '5 minutes')
    ORDER BY c.next_check_at NULLS FIRST, a.id LIMIT 100`;
  let queued = 0;
  for (const account of accounts) if ((await enqueueCreator(account.id, "system"))?.queued) queued++;
  return { queued };
}
