import { sql } from "@aihot/backend/db";
import { z } from "zod";
import { updateSource } from "@aihot/backend/admin/sources";
import { audit, Conflict } from "@aihot/backend/audit";
import { isRsshubRoute, LEGACY_RSSHUB_ROUTES } from "./rsshub-routes.ts";
import type { NewsBridgeSettings } from "../contracts.ts";
import { rsshubState } from "./rsshub-client.ts";

/** Configuration reads never contact RSSHub or expose the old bridge's ingest credential. */
export async function newsBridgeSettings(id: string): Promise<NewsBridgeSettings | null> {
  const [source] = await sql<{ id: string; name: string; updated_at: Date; archived: boolean; route: string | null; item_limit: number | null; ai_filter: boolean | null }[]>`
    SELECT s.id, s.name, s.updated_at, s.archived, bridge.route, bridge.item_limit, bridge.ai_filter
    FROM sources s LEFT JOIN studio_rsshub_bridges bridge ON bridge.source_id = s.id
    WHERE s.id = ${id} AND s.kind = 'external'
      AND NOT EXISTS (SELECT 1 FROM studio_trend_boards trend WHERE trend.source_id = s.id)`;
  if (!source) return null;
  if (source.archived) throw new Conflict("来源已移除，请先恢复到关注列表");
  const legacy = LEGACY_RSSHUB_ROUTES[id];
  return { id, name: source.name, route: source.route ?? legacy?.route ?? null, itemLimit: source.item_limit ?? legacy?.itemLimit ?? 15,
    aiFilter: source.ai_filter ?? legacy?.aiFilter ?? true, origin: source.route ? "custom" : legacy ? "legacy" : "missing",
    version: source.updated_at.toISOString(), runtimeState: rsshubState() };
}

const Input = z.object({
  version: z.iso.datetime(), name: z.string().trim().min(1).max(200),
  route: z.string().trim().min(2).max(1000).refine(isRsshubRoute, "请填写不含主机、参数、片段或路径穿越的 RSSHub 路由，例如 /qwen/blog"),
  itemLimit: z.number().int().min(1).max(50), aiFilter: z.boolean(),
}).strict();

/** Bridge options belong to this module; the existing source remains the collection identity. */
export async function saveNewsBridge(id: string, input: unknown, actor: string) {
  const data = Input.parse(input);
  const before = await newsBridgeSettings(id);
  if (!before) return null;
  return sql.begin(async tx => {
    const [current] = await tx<{ archived: boolean; kind: string }[]>`SELECT archived, kind FROM sources WHERE id = ${id} FOR UPDATE`;
    if (!current || current.kind !== "external") return null;
    if (current.archived) throw new Conflict("来源已移除，请先恢复到关注列表");
    await updateSource(id, { version: data.version, patch: { name: data.name, enabled: false } }, actor, tx);
    await tx`INSERT INTO studio_rsshub_bridges (source_id, route, item_limit, ai_filter)
      VALUES (${id}, ${data.route}, ${data.itemLimit}, ${data.aiFilter})
      ON CONFLICT (source_id) DO UPDATE SET route = EXCLUDED.route, item_limit = EXCLUDED.item_limit, ai_filter = EXCLUDED.ai_filter`;
    await audit(actor, "studio.source.bridge", `source:${id}`, null,
      { route: before.route, itemLimit: before.itemLimit, aiFilter: before.aiFilter },
      { route: data.route, itemLimit: data.itemLimit, aiFilter: data.aiFilter }, { db: tx });
    return { ok: true, id };
  });
}
