import { z } from "zod";
import { load } from "cheerio";
import { setTimeout as delay } from "node:timers/promises";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { shutdownSignal } from "@aihot/backend/jobs/queue";
import type { FilmBoardItem, FilmBoardSnapshot } from "../film-boards-contracts.ts";
import { filmBoardCatalog } from "./film-board-catalog.ts";

const text = z.string().trim().min(1).max(4000);
const identity = z.union([z.string().min(1).max(200), z.number().int().nonnegative().safe()]).transform(String);
const number = z.number().finite().nonnegative().nullable().optional();
const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const list = (value: unknown) => z.array(z.unknown()).max(1000).parse(value).map(record);
const optionalText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 4000) : null;
function link(value: unknown, base: string, sameOrigin = false) {
  const url = new URL(text.parse(value), base);
  if (url.protocol !== "https:" || url.username || url.password || url.port || sameOrigin && url.origin !== new URL(base).origin) throw new Error("来源链接不符合平台范围");
  return url.href;
}
const countMetric = (name: string, value: unknown, display?: unknown): FilmBoardItem["metrics"] => {
  const count = typeof value === "number" ? number.parse(value) ?? null : null;
  const rendered = optionalText(display) ?? (count === null ? null : String(count));
  return rendered === null ? [] : [{ name, value: count, text: rendered }];
};
/** Read a JSON assignment without evaluating the helper JavaScript following it. */
function routerData(source: string): Record<string, unknown> | null {
  const prefix = /(?:window\.)?_ROUTER_DATA\s*=\s*\{/.exec(source);
  if (!prefix) return null;
  const start = prefix.index + prefix[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return record(JSON.parse(source.slice(start, index + 1)));
  }
  throw new Error("官网初始数据不完整");
}

export async function readFilmBoard(id: string): Promise<FilmBoardSnapshot> {
  const board = filmBoardCatalog.find(board => board.id === id);
  const limit = board?.limit ?? 20;
  if (!board?.supported || !board.sourceUrl) throw new Error("榜单尚未接入");
  const signal = AbortSignal.any([shutdownSignal.signal, AbortSignal.timeout(60000)]);
  async function get(url: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await guardedFetch(url, { timeoutMs: 12000, maxBytes: 4 * 1024 ** 2, signal, redirect: "error",
          headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36" } });
        if (response.status === 200) return response.text();
        if (![429, 502, 503, 504].includes(response.status) || attempt >= 2) throw new Error("来源请求未成功");
      } catch (error) { if (signal.aborted || attempt >= 2 || error instanceof Error && error.message === "来源请求未成功") throw error; }
      await delay(250 * (attempt + 1), undefined, { signal });
    }
  }
  let items: FilmBoardItem[], sourceUpdatedText: string | null = null;
  if (id === "aitop100-short" || id === "aitop100-drama") {
    const group = id === "aitop100-drama";
    const url = `https://www.aitop100.cn/api/shortVideo/${group ? "group" : "works"}/page?curPage=1&limit=${limit}&${group ? "orderByPopularity=true&queryPopularityDetail=true" : "onlyNoGroup=true&orderByPopularity=true"}`;
    const row = z.object({ id: identity, worksName: text.optional(), groupName: text.optional(),
      worksIntro: z.string().max(8000).nullish(), groupIntro: z.string().max(8000).nullish(),
      authorNickName: z.string().max(4000).nullish(), totalPopularity: number, groupPopularity: number });
    const data = z.object({ code: z.literal(0), data: z.object({ list: z.array(row).max(100) }) }).parse(JSON.parse(await get(url)));
    items = data.data.list.map((item, index) => {
      const heat = (group ? item.groupPopularity : item.totalPopularity) ?? null;
      return { id: item.id, position: index + 1, title: text.parse(group ? item.groupName : item.worksName),
        url: `https://www.aitop100.cn/artcenter/aivlogdetail/${group ? "group" : "works"}/${encodeURIComponent(item.id)}.html`,
        author: item.authorNickName || null, sourceSummary: optionalText(group ? item.groupIntro : item.worksIntro),
        metrics: heat === null ? [] : [{ name: "来源综合热度", value: heat, text: String(heat) }] };
    });
  } else if (id === "reelshort" || id === "dramabox") {
    const $ = load(await get(board.sourceUrl)), state = record(record(record(JSON.parse($("script#__NEXT_DATA__").text())).props).pageProps);
    if (id === "reelshort") {
      const links = $("a[href]").toArray().map(element => $(element).attr("href")!);
      const rows = list(state.list).slice(0, limit);
      // SSR contains the full ordered list, but only renders twelve actual detail links per page.
      for (let page = 2; page <= Math.ceil(limit / 12) && rows.some(row => !links.some(href => href.includes(identity.parse(row.book_id)))); page++) {
        const next = links.find(href => href === `${new URL(board.sourceUrl!).pathname}/${page}`);
        if (!next) break;
        const nextPage = load(await get(link(next, board.sourceUrl, true)));
        links.push(...nextPage("a[href]").toArray().map(element => nextPage(element).attr("href")!));
      }
      items = rows.map((row, index) => {
        const entryId = identity.parse(row.book_id), href = links.find(href => href.includes(entryId));
        if (!href) throw new Error("未找到对应作品的官方详情链接");
        return { id: entryId, position: index + 1, title: text.parse(row.book_title), url: link(href, board.sourceUrl!, true),
          author: optionalText(row.author), sourceSummary: optionalText(row.special_desc),
          metrics: countMetric("read_count（来源观看计数）", row.read_count) };
      });
    } else {
      const group = list(state.smallData).find(row => String(row.id) === "1265");
      if (!group) throw new Error("未找到官方Trending推荐区");
      // This list is a single official shelf, not the combined home-page catalogue.
      const rows = list(group.items);
      items = rows.slice(0, limit).map((row, index) => ({ id: identity.parse(row.bookId), position: index + 1, title: text.parse(row.bookName),
        url: link(`/drama/${identity.parse(row.bookId)}/${text.parse(row.replacedBookName)}`, board.sourceUrl!, true),
        author: optionalText(row.author), sourceSummary: optionalText(row.introduction),
        metrics: countMetric("viewCount（来源观看计数）", row.viewCount, row.viewCountDisplay) }));
    }
  } else if (id === "netshort") {
    items = [];
    for (let page = 1; page <= Math.ceil(limit / 20); page++) {
      const url = page === 1 ? board.sourceUrl : `${board.sourceUrl}/page/${page}`, $ = load(await get(url));
      const graphs = $("script[type='application/ld+json']").toArray().flatMap(element => {
        const data = record(JSON.parse($(element).text())); return data["@graph"] ? list(data["@graph"]) : [data];
      });
      const group = graphs.find(row => row["@type"] === "ItemList" && row.name === "Hot Series");
      if (!group) throw new Error("未找到官方Hot Series列表");
      const rows = list(group.itemListElement);
      for (const row of rows) {
        const item = record(row.item), url = link(item.url, board.sourceUrl, true);
        items.push({ id: url, position: z.number().int().positive().parse(row.position), title: text.parse(item.name), url,
          author: optionalText(item.author), sourceSummary: optionalText(item.description), metrics: [] });
      }
      if (rows.length < 20) break;
    }
  } else if (board.group?.id === "hongguo") {
    const routeKey = `rank_${new URL(board.sourceUrl).pathname.split("/").at(-1)}/page`;
    items = [];
    for (let page = 1; page <= Math.ceil(limit / 20); page++) {
      const url = page === 1 ? board.sourceUrl : `${board.sourceUrl}?page=${page}`, $ = load(await get(url));
      let content: Record<string, unknown> | undefined;
      for (const element of $("script").toArray()) {
        const script = $(element), streamed = script.attr("data-fn-args");
        if (streamed && script.attr("data-fn-name") === "r") {
          const args = z.array(z.unknown()).parse(JSON.parse(streamed));
          if (args[0] === routeKey && args[1] === "content") content = record(args[2]);
        }
        const initial = routerData(script.text());
        if (initial) {
          const route = record(record(initial.loaderData)[routeKey]);
          sourceUpdatedText = optionalText(route.updatedText);
          const value = record(route.content);
          if (Array.isArray(value.rankList)) content = value;
        }
      }
      if (!content || content.isSuccess !== true) throw new Error("官网热播榜内容未成功返回");
      const rows = list(content.rankList);
      for (const row of rows) items.push({ id: identity.parse(row.seriesId ?? row.id), position: z.number().int().positive().parse(row.rank),
        title: text.parse(row.title), url: link(row.href, board.sourceUrl, true),
        author: optionalText(row.author), sourceSummary: optionalText(row.description),
        metrics: countMetric("热度", null, row.heatText) });
      if (rows.length < 20) break;
    }
  } else if (id === "verticalcharts-52") {
    const $ = load(await get(board.sourceUrl));
    const container = $(".vchart-wrapper[data-vc-type='rank'][data-vc-limit='52']").first();
    if (!container.length) throw new Error("未找到Vertical主榜容器");
    const rows = container.find("a.vchart-row").toArray();
    const allRows = rows.map(element => {
      const $row = $(element), rankText = $row.find(".vchart-rank").text().trim().replace(/[^\d]/g, ""), rank = Number.parseInt(rankText, 10);
      const href = $row.attr("href"), title = $row.find(".vchart-title").text().trim();
      const scoreText = $row.find(".vchart-score").text().trim(), score = Number.parseFloat(scoreText);
      if (!Number.isInteger(rank) || rank < 1 || !title || !href) throw new Error("Vertical主榜行字段不完整");
      const url = link(href, board.sourceUrl!, true);
      return { rank, title, url, score: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
        genreKeys: ($row.attr("data-g") ?? "").split(/\s+/).filter(Boolean),
        platformKey: ($row.attr("data-p") ?? "").trim() || null };
    });
    const byRankUrl = new Map<string, typeof allRows[number]>();
    for (const row of allRows) byRankUrl.set(`${row.rank}|${row.url}`, row);
    const unique = [...byRankUrl.values()].sort((a, b) => a.rank - b.rank);
    if (new Set(unique.map(row => row.rank)).size !== unique.length) throw new Error("Vertical主榜排名重复且链接不同");
    const top = unique.filter(row => row.rank <= limit);
    for (let rank = 1; rank <= limit; rank++) if (!top.some(row => row.rank === rank)) throw new Error("Vertical主榜前40名不完整");
    const countBy = (key: "genreKeys" | "platformKey") => {
      const counts = new Map<string, number>();
      for (const row of allRows) for (const value of key === "genreKeys" ? row.genreKeys : [row.platformKey].filter((value): value is string => !!value))
        counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    };
    const genreCounts = countBy("genreKeys"), platformCounts = countBy("platformKey");
    const categories = $("button[data-g]").toArray().map(element => {
      const key = ($(element).attr("data-g") ?? "").trim(), original = $(element).text().trim();
      if (!key || !original) return null;
      const trailing = /^(.*?)\s+(\d+)$/.exec(original), count = genreCounts.get(key) ?? 0;
      const verified = trailing && Number(trailing[2]) === count;
      return { key, labelOriginal: verified ? trailing![1]!.trim() : original, sourceCount: verified ? count : null };
    }).filter((value): value is NonNullable<typeof value> => !!value);
    const platforms = $("button[data-p]").toArray().map(element => {
      const key = ($(element).attr("data-p") ?? "").trim(); return key ? { key, label: key } : null;
    }).filter((value): value is NonNullable<typeof value> => !!value);
    const updated = /Updated\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/.exec($("body").text());
    sourceUpdatedText = updated ? `Updated ${updated[1]}` : null;
    items = top.map(row => ({
      id: row.url, position: row.rank, title: row.title, url: row.url, author: null,
      sourcePlatform: row.platformKey, sourcePlatformLabel: row.platformKey,
      genreKeys: row.genreKeys,
      countryStatus: "not_provided" as const, summaryStatus: "pending" as const,
      metrics: row.score === null ? [] : [{ name: "VertiScore（来源综合评分）", value: row.score, text: String(row.score) }],
    }));
    return { items, fetchedAt: new Date().toISOString(), sourceUpdatedText, sourceUrl: board.sourceUrl, requestedLimit: limit,
      schemaVersion: 2, sourceIssueDate: null, sourceTotal: allRows.length, categories, platforms };
  } else throw new Error("来源适配尚未完成");
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("榜单包含重复条目，未保存不确定顺序");
  return { items: items.slice(0, limit), fetchedAt: new Date().toISOString(), sourceUpdatedText, sourceUrl: board.sourceUrl, requestedLimit: limit };
}
