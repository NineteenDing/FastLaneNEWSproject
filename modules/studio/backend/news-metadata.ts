import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { audit, Conflict } from "@aihot/backend/audit";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { stripTags } from "@aihot/backend/lib/text";
import { iconCandidates } from "@aihot/backend/sources/icons";
import { resizeImage } from "@aihot/backend/media/images";
import { matchesSourceMetadata, requestedHomepage } from "./metadata-sql.ts";
import { createImageAssets } from "./image-assets.ts";
import { QueueDeferred, shutdownSignal } from "@aihot/backend/jobs/queue";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";

const Input = z.object({ version: z.iso.datetime(), profileVersion: z.number().int().nonnegative() }).strict();
const iconFile = (key: string) => path.join(config.dataDir, "studio", "source-icons", key);
const plain = (value: string | undefined, max: number) => stripTags(value ?? "").slice(0, max) || null;

function publicHomepage(value: string | undefined, base: string): string | null {
  try {
    const url = new URL(value ?? "", base);
    return value && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

async function page(url: string, beforeRequest: () => Promise<void>) {
  await beforeRequest();
  const response = await guardedFetch(url, { timeoutMs: 10000, maxBytes: 2 * 1024 * 1024 });
  if (response.status !== 200) throw new Error("Source unavailable");
  return { text: response.text(), url: response.url };
}

async function discover(source: { kind: string; config: Record<string, unknown>; homepage: string | null }, beforeRequest: () => Promise<void>) {
  let homepage = source.homepage;
  let description: string | null = null;
  let language: string | null = null;
  if (!homepage && source.kind === "rss") {
    const feed = await page(String(source.config.feedUrl ?? ""), beforeRequest);
    const $ = cheerio.load(feed.text, { xmlMode: true });
    const channel = $("rss > channel, rdf\\:RDF > channel").first();
    const atom = $("feed").first();
    const link = channel.length ? channel.children("link").first().text()
      : atom.children("link").filter((_, element) => !$(element).attr("rel") || $(element).attr("rel") === "alternate").first().attr("href");
    homepage = publicHomepage(link, feed.url);
    description = plain(channel.length ? channel.children("description").text() : atom.children("subtitle").text(), 1200);
    language = plain(channel.length ? channel.children("language").text() : atom.attr("xml:lang"), 80);
  } else if (!homepage && source.kind === "web_list") {
    homepage = publicHomepage(String(source.config.url ?? ""), "https://invalid.example");
  }
  if (!homepage) return { state: "needs_homepage", homepage: null, description, language, icon_key: null, icon_type: null, icon_state: "unknown" };
  const site = await page(homepage, beforeRequest);
  homepage = publicHomepage(site.url, homepage);
  if (!homepage) throw new Error("Homepage unavailable");
  const $ = cheerio.load(site.text);
  description ??= plain($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content"), 1200);
  language ??= plain($("html").attr("lang"), 80);
  let icon_key: string | null = null;
  let icon_type: string | null = null;
  let icon_state = "missing";
  for (const url of iconCandidates(site.text, site.url).slice(0, 5)) {
    try {
      await beforeRequest();
      const response = await guardedFetch(url, { timeoutMs: 5000, maxBytes: 2 * 1024 * 1024 });
      if (response.status !== 200) { if (response.status !== 404) icon_state = "failed"; continue; }
      const image = await resizeImage(response.body, response.headers.get("content-type") ?? "", "avatar");
      if (image.body.length > 128 * 1024 || !["image/webp", "image/png", "image/jpeg", "image/gif"].includes(image.type)) throw new Error("Icon unavailable");
      const saved = await createImageAssets().put(image);
      icon_key = saved.id;
      icon_type = saved.type;
      icon_state = "ok";
      break;
    } catch (error) { if (error instanceof Conflict || error instanceof QueueDeferred) throw error; icon_state = "failed"; }
  }
  return { state: "ok", homepage, description, language, icon_key, icon_type, icon_state };
}

/** Explicit metadata refresh; no material collection, public-image signature, or model call. */
export async function refreshNewsMetadata(id: string, input: unknown, actor: string, mode: "manual" | "background" = "manual") {
  const expected = Input.parse(input);
  const [source] = await sql<{ kind: string; config: Record<string, unknown>; updated_at: Date; enabled: boolean; archived: boolean; homepage: string | null; profile_version: number }[]>`
    SELECT s.kind, s.config, s.updated_at, s.enabled, s.archived,
      ${requestedHomepage(sql)} AS homepage, COALESCE(profile.version, 0) AS profile_version
    FROM sources s LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id WHERE s.id = ${id}`;
  if (!source) return null;
  const check = (version: Date, profileVersion: number, archived: boolean, enabled: boolean) => {
    if (mode === "background" && (!collectionEnabled() || shutdownSignal.signal.aborted)) throw new QueueDeferred("自动资料补全已暂停");
    if (mode === "background" && !enabled) throw new Conflict("来源已暂停，跳过旧资料任务");
    if (archived) throw new Conflict("来源已移除，请先恢复到关注列表");
    if (version.toISOString() !== expected.version || profileVersion !== expected.profileVersion)
      throw new Conflict("来源或资料已修改，请刷新后重试补全");
  };
  check(source.updated_at, source.profile_version, source.archived, source.enabled);
  const beforeRequest = async () => {
    if (mode !== "background") return;
    const [current] = await sql<{ updated_at: Date; enabled: boolean; archived: boolean; profile_version: number }[]>`
      SELECT s.updated_at, s.enabled, s.archived, COALESCE(profile.version, 0) AS profile_version
      FROM sources s LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id WHERE s.id = ${id}`;
    if (!current) throw new Conflict("来源已不存在");
    check(current.updated_at, current.profile_version, current.archived, current.enabled);
  };
  let result: Awaited<ReturnType<typeof discover>>;
  try { result = await discover(source, beforeRequest); }
  catch (error) {
    if (error instanceof Conflict || error instanceof QueueDeferred) throw error;
    result = { state: "failed", homepage: null, description: null, language: null, icon_key: null, icon_type: null, icon_state: "failed" };
  }
  return sql.begin(async tx => {
    const [current] = await tx<{ updated_at: Date; enabled: boolean; archived: boolean }[]>`SELECT updated_at, enabled, archived FROM sources WHERE id = ${id} FOR UPDATE`;
    const [profile] = await tx<{ version: number }[]>`SELECT version FROM studio_news_profiles WHERE source_id = ${id}`;
    if (!current) return null;
    check(current.updated_at, profile?.version ?? 0, current.archived, current.enabled);
    await tx`INSERT INTO studio_news_profiles (source_id, manual_fields) VALUES (${id}, '{}'::text[])
      ON CONFLICT (source_id) DO UPDATE SET version = studio_news_profiles.version + 1, updated_at = now()`;
    const keep = tx`EXCLUDED.state = 'failed' AND studio_source_metadata.config_fingerprint = EXCLUDED.config_fingerprint
      AND studio_source_metadata.requested_homepage IS NOT DISTINCT FROM EXCLUDED.requested_homepage`;
    const keepIcon = tx`(${keep}) OR (EXCLUDED.icon_state = 'failed'
      AND studio_source_metadata.config_fingerprint = EXCLUDED.config_fingerprint
      AND studio_source_metadata.requested_homepage IS NOT DISTINCT FROM EXCLUDED.requested_homepage
      AND studio_source_metadata.homepage IS NOT DISTINCT FROM EXCLUDED.homepage)`;
    const [saved] = await tx<{ icon_key: string | null }[]>`INSERT INTO studio_source_metadata (source_id, config_fingerprint, requested_homepage, description, language, homepage, icon_key, icon_type, state, icon_state)
      SELECT id, md5(kind || ':' || config::text), ${source.homepage}, ${result.description}, ${result.language}, ${result.homepage}, ${result.icon_key}, ${result.icon_type}, ${result.state}, ${result.icon_state}
      FROM sources WHERE id = ${id}
      ON CONFLICT (source_id) DO UPDATE SET config_fingerprint = EXCLUDED.config_fingerprint, requested_homepage = EXCLUDED.requested_homepage,
        description = CASE WHEN ${keep} THEN studio_source_metadata.description ELSE EXCLUDED.description END,
        language = CASE WHEN ${keep} THEN studio_source_metadata.language ELSE EXCLUDED.language END,
        homepage = CASE WHEN ${keep} THEN studio_source_metadata.homepage ELSE EXCLUDED.homepage END,
        icon_key = CASE WHEN ${keepIcon} THEN studio_source_metadata.icon_key ELSE EXCLUDED.icon_key END,
        icon_type = CASE WHEN ${keepIcon} THEN studio_source_metadata.icon_type ELSE EXCLUDED.icon_type END,
        state = EXCLUDED.state, icon_state = EXCLUDED.icon_state, checked_at = now() RETURNING icon_key`;
    const summary = { state: result.state, hasIcon: !!saved!.icon_key, iconState: result.icon_state };
    // Keep the owner unchanged when a temporary upstream failure retained its previous icon.
    if (!saved!.icon_key || saved!.icon_key === result.icon_key)
      await createImageAssets().setReferences(`source-avatar:${id}`, saved!.icon_key ? [saved!.icon_key] : [], tx);
    await audit(actor, "studio.source.metadata", `source:${id}`, null, null, summary, { db: tx });
    return summary;
  });
}

/** Read only saved local bytes; merely viewing a card never fetches an upstream avatar. */
export async function newsSourceAvatar(id: string) {
  const [row] = await sql<{ icon_key: string; icon_type: string }[]>`
    SELECT metadata.icon_key, metadata.icon_type FROM studio_source_metadata metadata JOIN sources s ON s.id = metadata.source_id
    LEFT JOIN studio_news_profiles profile ON profile.source_id = s.id
    WHERE s.id = ${id} AND ${matchesSourceMetadata(sql)}`;
  if (!row || !/^[a-f0-9]{64}$/.test(row.icon_key ?? "")) return null;
  const saved = await createImageAssets().read(row.icon_key);
  if (saved) return saved;
  // Existing local avatars remain readable until explicitly refreshed into the managed pool.
  const body = await readFile(iconFile(row.icon_key)).catch(() => null);
  return body && sha256(body) === row.icon_key ? { body, type: row.icon_type } : null;
}
