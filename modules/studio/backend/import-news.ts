import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { findDuplicateSource } from "@aihot/backend/admin/sources";

// Collector runtime state is intentionally not imported: this database has no old articles.
// Config remains intact, including legacy keys, for later collector compatibility diagnostics.
const Source = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200),
  kind: z.enum(["rss", "web_list", "json_list", "x_search", "mp_account", "external"]),
  config: z.record(z.string(), z.unknown()), tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true), tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]).default("T2"),
  first_party: z.boolean().default(false),
  participation_mode: z.enum(["editorial", "hot_signal", "isolated"]).default("editorial"),
  signal_group_id: z.string().nullable().default(null), owner_entity_id: z.string().nullable().default(null),
  interval_minutes: z.number().int().min(1).max(1440).default(30),
  site_fulltext: z.boolean().default(false), syndicate_fulltext: z.boolean().default(false),
  icon_url: z.string().nullable().default(null),
  created_at: z.coerce.date().optional(),
});

/** Operator import, also used by the authenticated import API. No network or job enqueueing. */
export async function importNewsSources(input: unknown, actor: string) {
  const { sources } = z.object({ sources: z.array(Source).max(5000) }).strict().parse(input);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('admin-source-identity'))`;
    let added = 0;
    for (const s of sources) {
      if ((await tx`SELECT id FROM sources WHERE id = ${s.id}`).length) continue;
      if (await findDuplicateSource(s.kind, s.config, undefined, tx)) continue;
      const inserted = await tx`
        INSERT INTO sources (id, name, kind, config, tags, enabled, tier, first_party,
          participation_mode, signal_group_id, owner_entity_id, interval_minutes,
          site_fulltext, syndicate_fulltext, icon_url, created_at)
        VALUES (${s.id}, ${s.name}, ${s.kind}, ${tx.json(s.config as never)}, ${s.tags}, ${s.enabled}, ${s.tier}, ${s.first_party},
          ${s.participation_mode}, ${s.signal_group_id}, ${s.owner_entity_id}, ${s.interval_minutes},
          ${s.site_fulltext}, ${s.syndicate_fulltext}, ${s.icon_url}, ${s.created_at ?? new Date()})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      added += inserted.length;
    }
    const result = { added, skipped: sources.length - added };
    if (added) await audit(actor, "studio.sources.import", null, "Import existing source settings; runtime state reset", null, result, { db: tx });
    return result;
  });
}
