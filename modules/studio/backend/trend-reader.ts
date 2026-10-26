// Adapted from newsnext/newsnow's six platform sources at 0560c993; see vendor/newsnow.
import { z } from "zod";
import { load } from "cheerio";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { shutdownSignal } from "@aihot/backend/jobs/queue";
import type { TrendPlatform, TrendSignal } from "../contracts.ts";

export type TrendItem = { externalId: string; title: string; url: string; rank: number; rawHeat: string | null; metrics: TrendSignal["observations"][number]["metrics"] };
const count = z.number().int().nonnegative().safe().nullable().optional();
const title = z.string().trim().min(1).max(500), id = z.union([z.string().min(1).max(300), z.number().int().nonnegative().safe()]).transform(String);
const heat = z.union([z.string().max(100), z.number().nonnegative().finite()]).nullish().transform(value => value == null ? null : String(value));
const emptyMetrics = () => ({ views: null, likes: null, comments: null });
export class TrendReadFailure extends Error {
  readonly code: "rate_limited" | "login_required" | "platform_failed";
  constructor(code: TrendReadFailure["code"]) { super("平台热榜请求未成功"); this.code = code; }
}

function platformUrl(value: string, base: string) {
  const parsed = new URL(value, base), host = new URL(base).hostname.replace(/^www\./, "");
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port
    || !(parsed.hostname === host || parsed.hostname.endsWith("." + host))) throw new Error("榜单链接不是对应平台的原始地址");
  parsed.protocol = "https:"; return parsed.href;
}

/**
 * Public fallback for the three platforms whose direct endpoints now redirect to login or
 * render bot-placeholder pages. 100tools.cn exposes a free, unauthenticated JSON hot-list API;
 * the trend schedule touches each platform at most every 30 minutes.
 */
const HUNDRED_HOSTS: Record<"weibo" | "zhihu" | "kuaishou", string[]> = {
  weibo: ["weibo.com", "s.weibo.com", "m.weibo.cn"],
  zhihu: ["zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"],
  kuaishou: ["kuaishou.com", "www.kuaishou.com"],
};
function hundredUrl(platform: "weibo" | "zhihu" | "kuaishou", title: string, value: string) {
  try {
    const url = new URL(value);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port
      && HUNDRED_HOSTS[platform].some(host => url.hostname === host || url.hostname.endsWith("." + host))) {
      url.protocol = "https:"; return url.href;
    }
  } catch { /* fall through to a platform search link */ }
  const query = encodeURIComponent(title);
  return platform === "weibo" ? `https://s.weibo.com/weibo?q=${query}`
    : platform === "zhihu" ? `https://www.zhihu.com/search?type=content&q=${query}`
    : `https://www.kuaishou.com/search/video?searchKey=${query}`;
}
async function readHundredTools(platform: "weibo" | "zhihu" | "kuaishou", signal: AbortSignal): Promise<TrendItem[]> {
  const itemSchema = z.object({
    id: z.union([z.string(), z.number()]).nullish(), title: z.string().trim().min(1).max(500),
    hot: z.union([z.string().max(100), z.number().finite()]).nullish(), url: z.string().max(4000).nullish(), mobileUrl: z.string().max(4000).nullish(),
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await guardedFetch(`https://100tools.cn/hot-api/${platform}`, { timeoutMs: 10000, maxBytes: 2 * 1024 ** 2, redirect: "error", signal,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
          referer: "https://100tools.cn/hot", accept: "application/json" } });
      if (response.status !== 200) throw new TrendReadFailure(response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "login_required" : "platform_failed");
      const payload = z.object({ code: z.literal(200), data: z.array(z.unknown()).max(200) }).parse(JSON.parse(response.text()));
      const seen = new Set<string>(), items: TrendItem[] = [];
      for (const raw of payload.data) {
        const parsed = itemSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data, externalId = String(item.id ?? item.url ?? item.title);
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        items.push({ externalId, title: item.title, rank: items.length + 1,
          url: hundredUrl(platform, item.title, item.mobileUrl ?? item.url ?? ""), rawHeat: item.hot == null ? null : String(item.hot), metrics: emptyMetrics() });
        if (items.length >= 20) break;
      }
      if (!items.length) throw new Error("100tools 未返回可用条目");
      return items;
    } catch (error) {
      lastError = error;
      if (error instanceof TrendReadFailure && error.code === "login_required") throw error;
      if (signal.aborted) throw error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  throw lastError;
}

/** Fixed platform endpoints use the existing TLS/SSRF, cancellation and full-body limits. */
export async function readTrendBoard(platform: TrendPlatform, cookie: string): Promise<TrendItem[]> {
  const signal = AbortSignal.any([shutdownSignal.signal, AbortSignal.timeout(10000)]);
  async function get(url: string, requestCookie = cookie) {
    const response = await guardedFetch(url, { timeoutMs: 10000, maxBytes: 2 * 1024 ** 2, redirect: "error", signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        ...(requestCookie ? { cookie: requestCookie } : {}) } });
    if (response.status !== 200) throw new TrendReadFailure(response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "login_required" : "platform_failed");
    return response;
  }
  try {
    switch (platform) {
    case "baidu": {
      // NewsNow 0560c993 server/sources/baidu.ts: s-data cards, omit pinned topics.
      const response = await get("https://top.baidu.com/board?tab=realtime", "");
      const captured = response.text().match(/<!--s-data:(.*?)-->/s);
      if (!captured) throw new Error("未取得百度榜单内容");
      const result = z.object({ data: z.object({ cards: z.array(z.object({ content: z.array(z.object({
        isTop: z.boolean().optional(), word: title, rawUrl: z.url(), hotScore: heat,
      })).max(100) })).min(1).max(20) }) }).parse(JSON.parse(captured[1]!));
      return result.data.cards[0]!.content.filter(item => !item.isTop).slice(0, 20).map((item, index) => ({
        externalId: item.rawUrl, title: item.word, url: platformUrl(item.rawUrl, "https://www.baidu.com"),
        rank: index + 1, rawHeat: item.hotScore, metrics: emptyMetrics(),
      }));
    }
    case "bilibili": {
      const response = await get("https://api.bilibili.com/x/web-interface/popular");
      const result = z.object({ code: z.literal(0), data: z.object({ list: z.array(z.object({
        bvid: z.string().regex(/^BV[A-Za-z0-9]{10}$/), title, stat: z.object({ view: count, like: count, reply: count }),
      })).max(100) }) }).parse(JSON.parse(response.text()));
      return result.data.list.slice(0, 20).map((video, index) => ({ externalId: video.bvid, title: video.title,
        url: `https://www.bilibili.com/video/${video.bvid}`, rank: index + 1, rawHeat: null,
        metrics: { views: video.stat.view ?? null, likes: video.stat.like ?? null, comments: video.stat.reply ?? null } }));
    }
    case "douyin": {
      const bootstrap = await get("https://login.douyin.com/", "");
      const temporaryCookie = bootstrap.headers.getSetCookie().map(value => value.split(";", 1)[0]).filter(Boolean).join("; ");
      const response = await get("https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1", [cookie, temporaryCookie].filter(Boolean).join("; "));
      const result = z.object({ status_code: z.literal(0).optional(), data: z.object({ word_list: z.array(z.object({ sentence_id: id, word: title, hot_value: heat })).max(100) }) }).parse(JSON.parse(response.text()));
      return result.data.word_list.slice(0, 20).map((item, index) => ({ externalId: item.sentence_id, title: item.word,
        url: `https://www.douyin.com/hot/${encodeURIComponent(item.sentence_id)}`, rank: index + 1, rawHeat: item.hot_value, metrics: emptyMetrics() }));
    }
    case "weibo": {
      const response = await get("https://s.weibo.com/top/summary?cate=realtimehot"), $ = load(response.text());
      if (!$("#pl_top_realtimehot table tbody").length) throw new Error("未取得微博榜单，可能需要登录或人工验证");
      const result: TrendItem[] = [];
      for (const row of $("#pl_top_realtimehot table tbody tr").toArray()) {
        const rankText = $(row).find("td.td-01").text().trim();
        if (!/^\d+$/.test(rankText)) continue;
        const link = $(row).find("td.td-02 a").filter((_index, element) => !!$(element).attr("href") && !$(element).attr("href")!.startsWith("javascript:")).first();
        const name = title.parse(link.text()), url = platformUrl(link.attr("href") ?? "", "https://s.weibo.com");
        result.push({ externalId: name, title: name, url, rank: z.coerce.number().int().positive().parse(rankText),
          rawHeat: heat.parse($(row).find("td.td-02 span").first().text().trim() || null), metrics: emptyMetrics() });
      }
      if (result.length > 100) throw new Error("微博榜单超出处理上限");
      return result.slice(0, 20);
    }
    case "zhihu": {
      const response = await get("https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true");
      const result = z.object({ data: z.array(z.object({ target: z.object({ title_area: z.object({ text: title }),
        link: z.object({ url: z.string().url() }), metrics_area: z.object({ text: heat }).optional() }) })).max(100) }).parse(JSON.parse(response.text()));
      return result.data.slice(0, 20).map((item, index) => ({ externalId: item.target.link.url.match(/(\d+)$/)?.[1] ?? item.target.link.url,
        title: item.target.title_area.text, url: platformUrl(item.target.link.url, "https://www.zhihu.com"),
        rank: index + 1, rawHeat: item.target.metrics_area?.text ?? null, metrics: emptyMetrics() }));
    }
    case "tieba": {
      const response = await get("https://tieba.baidu.com/hottopic/browse/topicList");
      const result = z.object({ data: z.object({ bang_topic: z.object({ topic_list: z.array(z.object({ topic_id: id, topic_name: title, topic_url: z.string().url() })).max(100) }) }) }).parse(JSON.parse(response.text()));
      return result.data.bang_topic.topic_list.slice(0, 20).map((item, index) => ({ externalId: item.topic_id, title: item.topic_name,
        url: platformUrl(item.topic_url, "https://tieba.baidu.com"), rank: index + 1, rawHeat: null, metrics: emptyMetrics() }));
    }
    case "kuaishou": {
      const response = await get("https://www.kuaishou.com/?isHome=1");
      const captured = response.text().match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
      if (!captured) throw new Error("未取得快手榜单状态");
      const client = z.object({ defaultClient: z.record(z.string(), z.unknown()) }).parse(JSON.parse(captured[1]!)).defaultClient;
      const root = z.object({ 'visionHotRank({"page":"home"})': z.object({ id }) }).parse(client.ROOT_QUERY);
      const rank = z.object({ result: z.literal(1), items: z.array(z.object({ id })).max(100) }).parse(client[root['visionHotRank({"page":"home"})'].id]);
      const result = rank.items.map(item => ({ id: item.id, value: z.object({ name: title, tagType: z.string().optional() }).parse(client[item.id]) })).filter(item => item.value.tagType !== "置顶");
      return result.slice(0, 20).map((item, index) => ({ externalId: item.id.replace(/^VisionHotRankItem:/, ""), title: item.value.name,
        url: `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(item.value.name)}`, rank: index + 1, rawHeat: null, metrics: emptyMetrics() }));
    }
    default: throw new Error("此榜单尚待适配");
    }
  } catch (error) {
    if (platform === "weibo" || platform === "zhihu" || platform === "kuaishou") return readHundredTools(platform, signal);
    throw error;
  }
}
