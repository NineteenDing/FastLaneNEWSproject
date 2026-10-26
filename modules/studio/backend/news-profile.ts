import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { matchesSourceMetadata } from "./metadata-sql.ts";

const text = (max: number) => z.string().trim().max(max).nullable().transform(value => value || null);
const homepage = text(2000).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "请填写不带账号、查询参数或片段的 HTTP(S) 主页地址");
const Profile = z.object({
  version: z.number().int().nonnegative(),
  description: text(1200), region: text(80), language: text(80), homepage,
}).strict();

/** The source row serializes first-time profile creation as well as concurrent edits. */
export async function saveNewsProfile(id: string, input: unknown, actor: string) {
  const { version, ...profile } = Profile.parse(input);
  return sql.begin(async (tx) => {
    const [source] = await tx`SELECT id FROM sources WHERE id = ${id} FOR UPDATE`;
    if (!source) return null;
    const [before] = await tx`SELECT description, region, language, homepage, version, manual_fields FROM studio_news_profiles WHERE source_id = ${id}`;
    if ((before?.version ?? 0) !== version) throw new Conflict("资料已被其他窗口修改，请刷新后再编辑");
    const [automatic] = await tx`SELECT metadata.description, metadata.language, metadata.homepage FROM studio_source_metadata metadata
      JOIN sources s ON s.id = metadata.source_id LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
      WHERE s.id = ${id} AND ${matchesSourceMetadata(tx)}`;
    const manualFields = new Set<string>(before?.manual_fields as string[] ?? []);
    for (const [field, value] of Object.entries(profile)) {
      const previous = manualFields.has(field) ? before?.[field] ?? null : automatic?.[field] ?? null;
      if (value !== previous) manualFields.add(field);
    }
    await tx`INSERT INTO studio_news_profiles (source_id, description, region, language, homepage, version, manual_fields)
      VALUES (${id}, ${profile.description}, ${profile.region}, ${profile.language}, ${profile.homepage}, ${version + 1}, ${[...manualFields]}::text[])
      ON CONFLICT (source_id) DO UPDATE SET description = EXCLUDED.description, region = EXCLUDED.region,
        language = EXCLUDED.language, homepage = EXCLUDED.homepage, manual_fields = EXCLUDED.manual_fields, version = EXCLUDED.version, updated_at = now()`;
    await audit(actor, "studio.source.profile", `source:${id}`, null, before ?? null, { ...profile, version: version + 1 }, { db: tx });
    return { version: version + 1 };
  });
}
