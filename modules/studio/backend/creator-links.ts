import { z } from "zod";
import type { CreatorPlatform } from "../contracts.ts";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

// Creator URL patterns adapted from MediaCrawler 8f583999006d5b692272c608440e193ca282e73b:
// media_platform/{bilibili,douyin,kuaishou,xhs}/help.py. Copyright (c) 2025 relakkes@gmail.com.
// NON-COMMERCIAL LEARNING LICENSE 1.1; see ../vendor/mediacrawler/LICENSE and NOTICE.md.
const rules: Array<{ platform: CreatorPlatform; hosts: string[]; path: RegExp; prefix: string }> = [
  { platform: "bilibili", hosts: ["space.bilibili.com"], path: /^\/(\d{1,30})\/?$/, prefix: "https://space.bilibili.com/" },
  { platform: "xhs", hosts: ["www.xiaohongshu.com", "xiaohongshu.com"], path: /^\/user\/profile\/([a-fA-F0-9]{24})\/?$/, prefix: "https://www.xiaohongshu.com/user/profile/" },
  { platform: "douyin", hosts: ["www.douyin.com", "douyin.com"], path: /^\/user\/([A-Za-z0-9_-]{1,200})\/?$/, prefix: "https://www.douyin.com/user/" },
  { platform: "kuaishou", hosts: ["www.kuaishou.com", "kuaishou.com"], path: /^\/profile\/([A-Za-z0-9_-]{1,200})\/?$/, prefix: "https://www.kuaishou.com/profile/" },
  { platform: "weibo", hosts: ["weibo.com", "www.weibo.com", "m.weibo.cn"], path: /^\/(?:u|profile)\/(\d{1,30})\/?$/, prefix: "https://weibo.com/u/" },
  { platform: "zhihu", hosts: ["www.zhihu.com", "zhihu.com"], path: /^\/people\/([A-Za-z0-9_-]{1,200})(?:\/(?:answers|posts|activities|videos|pins))?\/?$/, prefix: "https://www.zhihu.com/people/" },
];

/** Explicit host/path validation precedes any collector work. This function makes no requests. */
export function creatorLink(input: unknown): { platform: CreatorPlatform; locator: string; homepage: string; context: Record<string, string> } {
  const value = z.string().trim().min(1).max(3000).parse(input);
  const address = z.url().refine(value => {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port;
  }, "请填写平台公开主页链接").parse(value);
  const url = new URL(address);
  for (const rule of rules) {
    const raw = rule.hosts.includes(url.hostname) ? rule.path.exec(url.pathname)?.[1] : undefined;
    if (!raw) continue;
    const locator = rule.platform === "bilibili" || rule.platform === "weibo" ? BigInt(raw).toString() : rule.platform === "xhs" ? raw.toLowerCase() : raw;
    const context: Record<string, string> = {};
    if (rule.platform === "xhs") for (const key of ["xsec_token", "xsec_source"]) {
      const value = url.searchParams.get(key);
      if (value) context[key] = z.string().max(2048).parse(value);
    }
    return { platform: rule.platform, locator, homepage: rule.prefix + locator, context };
  }
  // MediaCrawler's config/tieba_config.py accepts the portrait id in a complete /home/main URL.
  if (url.hostname === "tieba.baidu.com" && /^\/home\/main\/?$/.test(url.pathname)) {
    const locator = url.searchParams.get("id");
    if (locator && /^tb\.[A-Za-z0-9_.-]{1,197}$/.test(locator) && url.searchParams.getAll("id").length === 1)
      return { platform: "tieba", locator, homepage: "https://tieba.baidu.com/home/main?id=" + encodeURIComponent(locator), context: {} };
  }
  throw new z.ZodError([{ code: "custom", path: ["url"], message: "暂未识别完整博主主页，请粘贴平台个人主页地址" }]);
}

function shortPlatform(url: URL): CreatorPlatform | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname === "b23.tv" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return "bilibili";
  if (url.hostname === "v.douyin.com" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return "douyin";
  if ((url.hostname === "v.kuaishou.com" || url.hostname === "www.kuaishou.com" && url.pathname.startsWith("/f/"))
    && /^\/(?:f\/)?[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return "kuaishou";
  if ((url.hostname === "xhslink.com" || url.hostname === "www.xhslink.com") && /^\/(?:[A-Za-z]\/)?[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return "xhs";
  if (url.hostname === "t.cn" && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return "weibo";
  return null;
}
const shareError = () => new z.ZodError([{ code: "custom", path: ["url"], message: "分享链接未指向可识别的博主主页，请复制完整个人主页链接重试" }]);

/** Resolve only known share hosts. Stop at a validated homepage without fetching its HTML. */
export async function resolveCreatorLink(input: unknown) {
  const text = z.string().trim().min(1).max(8000).parse(input);
  const urls = text.match(/https?:\/\/[^\s<>"'，。；、！？（）【】「」]+/g);
  if (!urls || urls.length !== 1) throw shareError();
  let url: URL;
  try { url = new URL(urls[0]!.replace(/[),.;!?]+$/, "")); } catch { throw shareError(); }
  try { return creatorLink(url.href); } catch { /* Known short links are resolved below. */ }
  const platform = shortPlatform(url); if (!platform) throw shareError();
  const signal = AbortSignal.timeout(10000), visited = new Set<string>();
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (visited.has(url.href) || shortPlatform(url) !== platform) throw shareError();
      visited.add(url.href);
      const response = await guardedFetch(url.href, { redirect: "manual", timeoutMs: 10000, signal, maxBytes: 64 * 1024 });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw shareError();
      url = new URL(location, url);
      try {
        const creator = creatorLink(url.href);
        if (creator.platform !== platform) throw shareError();
        return creator;
      } catch { if (shortPlatform(url) !== platform) throw shareError(); }
    }
  } catch { throw shareError(); }
  throw shareError();
}
