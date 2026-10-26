import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { Conflict, audit } from "@aihot/backend/audit";
import type { TrendBoards, TrendPlatform } from "../contracts.ts";
import type { Db } from "@aihot/backend/db";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";

export const trendCatalog = [
  { platform: "douyin", name: "抖音热榜", homepage: "https://www.douyin.com/hot" },
  { platform: "bilibili", name: "B站热门视频", homepage: "https://www.bilibili.com/v/popular/all" },
  { platform: "weibo", name: "微博热搜", homepage: "https://s.weibo.com/top/summary?cate=realtimehot" },
  { platform: "zhihu", name: "知乎热榜", homepage: "https://www.zhihu.com/hot", legacySourceId: "src-zhihu-hot" },
  { platform: "tieba", name: "贴吧热议", homepage: "https://tieba.baidu.com/hottopic/browse/hottopic" },
  { platform: "kuaishou", name: "快手热榜", homepage: "https://www.kuaishou.com" },
  { platform: "baidu", name: "百度热搜", homepage: "https://top.baidu.com/board?tab=realtime" },
] as const;
const platformSchema = z.enum(["douyin", "bilibili", "weibo", "zhihu", "tieba", "kuaishou", "xhs", "baidu"]);
type Source = { id: string; name: string; enabled: boolean; archived: boolean; version: Date; kind: string; tags: string[] };
const sourceId = (platform: string) => `src-trending-${platform}`;

export async function trendSourcePlatform(sourceId: string, db: Db = sql) {
  const [row] = await db<{ platform: TrendPlatform }[]>`SELECT platform FROM studio_trend_boards WHERE source_id = ${sourceId}`;
  return row?.platform ?? null;
}

/** Lists capability and existing identities only; never creates a source or contacts platforms. */
export async function trendBoards(): Promise<TrendBoards> {
  const bindings = await sql<{ platform: TrendPlatform; source_id: string; state: string; checked_at: Date | null; item_count: number | null; error_code: string | null }[]>`
    SELECT b.platform, b.source_id, coalesce(c.state, 'not_checked') AS state, c.checked_at, c.item_count, c.error_code
    FROM studio_trend_boards b LEFT JOIN studio_trend_collection c USING (platform)`;
  const ids = bindings.map(binding => binding.source_id).concat(trendCatalog.map(board => "legacySourceId" in board ? board.legacySourceId : sourceId(board.platform)));
  const sources = await sql<Source[]>`SELECT id, name, kind, tags, enabled, archived, updated_at AS version FROM sources WHERE id = ANY(${ids}::text[])`;
  return { collectionEnabled: collectionEnabled(), rows: [...trendCatalog, { platform: "xhs" as const, name: "小红书热榜", homepage: "https://www.xiaohongshu.com" }].map(board => {
    const binding = bindings.find(item => item.platform === board.platform);
    const existingId = binding?.source_id ?? ("legacySourceId" in board ? board.legacySourceId : sourceId(board.platform));
    const source = sources.find(item => item.id === existingId);
    return { platform: board.platform, name: board.name, homepage: board.homepage, supported: board.platform !== "xhs",
      unsupportedReason: board.platform === "xhs" ? "小红书热榜尚待适配；博主关注能力独立提供" : null, connected: !!binding,
      collection: binding ? { state: binding.state, checkedAt: binding.checked_at?.toISOString() ?? null, itemCount: binding.item_count, errorCode: binding.error_code } : null,
      source: source ? { id: source.id, name: source.name, enabled: source.enabled, archived: source.archived, version: source.version.toISOString() } : null };
  }) };
}

/** Explicit opt-in. Reuses the same board's legacy source, never an unrelated platform feed. */
export async function connectTrendBoard(platform: string, input: unknown, actor: string) {
  const parsed = platformSchema.parse(platform), value = z.object({ sourceVersion: z.iso.datetime().optional(), enabled: z.boolean().default(false) }).strict().parse(input);
  const board = trendCatalog.find(item => item.platform === parsed);
  if (!board) throw new Conflict("小红书热榜尚待适配，当前不能接入");
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtext('admin-source-identity'))`;
    const [connected] = await db<{ source_id: string }[]>`SELECT source_id FROM studio_trend_boards WHERE platform = ${parsed}`;
    if (connected) {
      if (value.enabled) {
        const [current] = await db<Source[]>`SELECT updated_at AS version FROM sources WHERE id = ${connected.source_id} FOR UPDATE`;
        await updateSource(connected.source_id, { version: value.sourceVersion ?? current!.version.toISOString(), patch: { enabled: true } }, actor, db);
      }
      return { created: false, sourceId: connected.source_id };
    }
    const legacyId = "legacySourceId" in board ? board.legacySourceId : null;
    const [existing] = legacyId ? await db<Source[]>`SELECT id, name, kind, tags, enabled, archived, updated_at AS version FROM sources WHERE id = ${legacyId} FOR UPDATE` : [];
    let id = sourceId(parsed);
    if (existing) {
      if (existing.kind !== "external" || existing.archived || value.sourceVersion !== existing.version.toISOString())
        throw new Conflict("已有热榜来源状态已改变，请刷新并确认接入；已移除来源须先恢复");
      const [running] = await db`SELECT id FROM fetch_runs WHERE source_id = ${existing.id} AND status = 'running' LIMIT 1`;
      if (running) throw new Conflict("旧采集任务尚未结束，请完成或恢复该任务后再接入热榜");
      id = existing.id;
      await updateSource(id, { version: value.sourceVersion!, patch: { enabled: false, interval_minutes: 30,
        participation_mode: "hot_signal", tags: [...new Set(existing.tags.concat("平台热榜"))] } }, actor, db);
    } else {
      await createSource({ id, name: board.name, kind: "external", config: {}, enabled: false, interval_minutes: 30,
        participation_mode: "hot_signal", tags: ["平台热榜"], site_fulltext: false, syndicate_fulltext: false }, actor, db);
    }
    await db`INSERT INTO studio_trend_boards (platform, source_id) VALUES (${parsed}, ${id})`;
    if (value.enabled) {
      const [current] = await db<Source[]>`SELECT updated_at AS version FROM sources WHERE id = ${id}`;
      await updateSource(id, { version: current!.version.toISOString(), patch: { enabled: true } }, actor, db);
    }
    await audit(actor, "studio.trend.connect", `source:${id}`, null, null, { platform: parsed }, { db });
    return { created: true, sourceId: id };
  });
}
