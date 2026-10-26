import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import { newsBridgeSettings } from "./news-bridge.ts";
import { readRsshub, rsshubOrigin } from "./rsshub-client.ts";
import { AI_RE } from "./rsshub-keywords.ts";

export async function readNewsBridge(source: SourceRow) {
  const settings = await newsBridgeSettings(source.id);
  const origin = rsshubOrigin();
  if (!settings?.route || !origin) throw new UnsupportedConfig("请先配置RSSHub运行服务及来源路由");
  const url = new URL(settings.route, origin);
  url.searchParams.set("limit", String(settings.itemLimit));
  const result = await fetchRss({ ...source, config: { feedUrl: url.href } }, { force: true, read: readRsshub });
  if (result.candidates.length > settings.itemLimit) throw new Error("RSSHub未遵守处理上限，本次结果未接受，请检查服务");
  const excluded = settings.aiFilter ? result.candidates.filter(candidate => !AI_RE.test(`${candidate.title} ${candidate.excerpt ?? ""}`)) : [];
  const rejected = new Set(excluded);
  return { candidates: result.candidates.filter(candidate => !rejected.has(candidate)), initialBackfillLimit: settings.itemLimit, detail: { via: "rsshub",
    received: result.candidates.length, requestedLimit: settings.itemLimit, feedWindowOnly: true, filteredByKeyword: excluded.length,
    excluded: excluded.map(candidate => ({ title: candidate.title, url: candidate.url, reason: "keyword_filter" })) } };
}
