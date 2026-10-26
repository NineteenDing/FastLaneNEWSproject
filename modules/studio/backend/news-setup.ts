import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { createSource, findDuplicateSource, previewSource, updateSource } from "@aihot/backend/admin/sources";
import { Conflict } from "@aihot/backend/audit";
import { newUuid } from "@aihot/backend/lib/ids";
import type { CollectionSource } from "@aihot/backend/modules";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { assertSupportedConfig, UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { NewsSourceSettings } from "../contracts.ts";

const Input = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["rss", "web_list"]),
  url: z.string().trim().max(2000).url().refine(value => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, "请填写不含账号密码的 HTTP(S) 地址"),
  intervalMinutes: z.number().int().min(1).max(1440).default(30),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();

function configuration(data: z.infer<typeof Input>) {
  const config: Record<string, unknown> = { ...data.config, ...(data.kind === "rss" ? { feedUrl: data.url } : { url: data.url }) };
  assertSupportedConfig(data.kind, config);
  return config;
}

function needsWebRules(config: Record<string, unknown>) {
  return !config.itemSelector && !config.adapter
    && !["docusaurus_changelog", "intercom_changelog"].includes(String(config.parseMode));
}

/** An expired trial stops describing the config, but never removes workbench readiness protection. */
export async function assertNewsSourceReady(source: CollectionSource, db: Db) {
  const [checked] = await db`SELECT source_id FROM studio_source_checks WHERE source_id = ${source.id}`;
  if (checked && needsWebRules(source.config)) throw new UnsupportedConfig("网页来源尚未配置提取规则，请先打开采集设置");
}

async function trial(id: string, data: z.infer<typeof Input>, config: Record<string, unknown>) {
  const needsRules = data.kind === "web_list" && needsWebRules(config);
  let state = needsRules ? "needs_config" : "ok";
  let count: number | null = null;
  try {
    if (needsRules) {
      const response = await guardedFetch(data.url, { maxBytes: 4 * 1024 * 1024 });
      if (response.status < 200 || response.status >= 300) throw new Error("Source unavailable");
    } else count = (await previewSource({ id, kind: data.kind, config })).count;
  } catch { state = "failed"; }
  return { state, count };
}

async function saveTrial(tx: Tx, sourceId: string, result: Awaited<ReturnType<typeof trial>>) {
  await tx`INSERT INTO studio_source_checks (source_id, config_fingerprint, state, checked_at, item_count)
    SELECT id, md5(kind || ':' || config::text), ${result.state}, now(), ${result.count} FROM sources WHERE id = ${sourceId}
    ON CONFLICT (source_id) DO UPDATE SET config_fingerprint = EXCLUDED.config_fingerprint,
      state = EXCLUDED.state, checked_at = EXCLUDED.checked_at, item_count = EXCLUDED.item_count`;
}

/** Reuse the existing bounded preview and source identity; a trial read never imports material. */
export async function createNewsSource(input: unknown, actor: string) {
  const data = Input.parse(input);
  const config = configuration(data);
  const duplicate = await findDuplicateSource(data.kind, config);
  if (duplicate) {
    const [source] = await sql<{ archived: boolean }[]>`SELECT archived FROM sources WHERE id = ${duplicate.id}`;
    return { created: false, id: duplicate.id, archived: source!.archived };
  }
  const id = `news-${newUuid()}`;
  const validation = await trial(id, data, config);
  return sql.begin(async tx => {
    const result = await createSource({ id, name: data.name, kind: data.kind, config,
      interval_minutes: data.intervalMinutes, enabled: false }, actor, tx);
    const sourceId = result.created ? result.source.id : result.duplicate.id;
    if (result.created) await saveTrial(tx, sourceId, validation);
    const [source] = await tx<{ archived: boolean }[]>`SELECT archived FROM sources WHERE id = ${sourceId}`;
    return { created: result.created, id: sourceId, archived: source!.archived };
  });
}

/** Only the explicit private editor reads collector configuration; cards never receive it. */
export async function newsSourceSettings(id: string): Promise<NewsSourceSettings | null> {
  const [source] = await sql<{ id: string; name: string; kind: "rss" | "web_list"; config: Record<string, unknown>; interval_minutes: number; updated_at: Date; archived: boolean }[]>`
    SELECT id, name, kind, config, interval_minutes, updated_at, archived FROM sources WHERE id = ${id} AND kind IN ('rss', 'web_list')`;
  if (!source) return null;
  if (source.archived) throw new Conflict("来源已移除，请先恢复到关注列表");
  const { [source.kind === "rss" ? "feedUrl" : "url"]: url, ...rules } = source.config;
  return { id: source.id, name: source.name, kind: source.kind, url: String(url ?? ""), config: rules,
    intervalMinutes: source.interval_minutes, version: source.updated_at.toISOString() };
}

export async function updateNewsSource(id: string, input: unknown, actor: string) {
  const { version, ...data } = Input.extend({ version: z.iso.datetime() }).parse(input);
  const before = await newsSourceSettings(id);
  if (!before) return null;
  if (before.version !== version) throw new Conflict("采集设置已被其他操作修改，请刷新后再编辑");
  const config = configuration(data);
  const validation = await trial(id, data, config);
  return sql.begin(async tx => {
    const saved = await updateSource(id, { version, patch: { name: data.name, kind: data.kind, config,
      interval_minutes: data.intervalMinutes, enabled: false } }, actor, tx);
    if (!saved) return null;
    await saveTrial(tx, id, validation);
    return { created: false, id, archived: false };
  });
}
