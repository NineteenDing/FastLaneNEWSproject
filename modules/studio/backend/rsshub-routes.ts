// Route data reused from the user's FastlaneNews/bridge/rsshub-to-aihot.mjs; see REUSE.md.
// No original paths, ports, tokens, executable code or fixed keyword filter are carried over.
export function isRsshubRoute(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return value.length <= 1000 && !/%(?:2f|5c)/i.test(value) && /^\/[\p{L}\p{N}_~./-]+$/u.test(decoded)
      && decoded.split("/").slice(1).every(part => part !== "" && part !== "." && part !== "..");
  } catch { return false; }
}

export const LEGACY_RSSHUB_ROUTES: Readonly<Record<string, { route: string; itemLimit: number; aiFilter: boolean }>> = {
  "src-36kr-newsflash": {
    "route": "/36kr/newsflashes",
    "itemLimit": 12,
    "aiFilter": true
  },
  "src-deepseek-changelog": {
    "route": "/deepseek/changelog/zh",
    "itemLimit": 8,
    "aiFilter": false
  },
  "src-qwen-blog": {
    "route": "/qwen/blog",
    "itemLimit": 8,
    "aiFilter": false
  },
  "src-qbitai-ai": {
    "route": "/qbitai/tag/AI",
    "itemLimit": 10,
    "aiFilter": false
  },
  "src-aibase-news": {
    "route": "/aibase/news",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-aibot-daily": {
    "route": "/ai-bot/daily-ai-news",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-anthropic-news": {
    "route": "/anthropic/news",
    "itemLimit": 8,
    "aiFilter": false
  },
  "src-sspai": {
    "route": "/sspai/index",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-juejin": {
    "route": "/juejin/category/frontend",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-zhihu-hot": {
    "route": "/zhihu/hot",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-baidu-top": {
    "route": "/baidu/top",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-nowcoder": {
    "route": "/nowcoder/hots",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-ifeng-news": {
    "route": "/ifeng/news",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-chongbuluo": {
    "route": "/chongbuluo/newthread",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-freebuf": {
    "route": "/freebuf/articles/web",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-zaobao": {
    "route": "/zaobao/realtime",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-wallstreetcn": {
    "route": "/wallstreetcn/hot",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-cls": {
    "route": "/cls/hot",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-gelonghui": {
    "route": "/gelonghui/hot-article",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-jin10": {
    "route": "/jin10/important",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-coolapk": {
    "route": "/coolapk/hot",
    "itemLimit": 10,
    "aiFilter": true
  },
  "src-bilibili": {
    "route": "/bilibili/precious",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-tieba-ai": {
    "route": "/baidu/tieba/forum/人工智能",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-tieba-aibar": {
    "route": "/baidu/tieba/forum/ai",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-tieba-chatgpt": {
    "route": "/baidu/tieba/forum/chatgpt",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-tieba-llm": {
    "route": "/baidu/tieba/forum/大模型",
    "itemLimit": 15,
    "aiFilter": true
  },
  "src-tieba-aipaint": {
    "route": "/baidu/tieba/forum/ai绘画",
    "itemLimit": 10,
    "aiFilter": true
  }
};
