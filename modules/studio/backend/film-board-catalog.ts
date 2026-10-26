import type { FilmBoard } from "../film-boards-contracts.ts";

type CatalogEntry = Pick<FilmBoard, "id" | "name" | "region" | "scope" | "ordering" | "sourceUrl" | "note" | "supported" | "group"> & { limit?: number; retired?: boolean };
/** Official identities and actual list kinds verified in PHASE2-FILM-SOURCE-RESEARCH.md. */
export const filmBoardCatalog: CatalogEntry[] = [
  { id: "aitop100-short", group: { id: "aitop100", name: "AI TOP100", category: "AI短片榜" }, name: "AI TOP100 · AI短片榜", region: "domestic", scope: "ai", ordering: "ranking", supported: true,
    sourceUrl: "https://www.aitop100.cn/artcenter/aivloglist.html", note: "来源热度包含平台整理数据，不等于已验证播放量。" },
  { id: "aitop100-drama", group: { id: "aitop100", name: "AI TOP100", category: "AI短剧榜" }, name: "AI TOP100 · AI短剧榜", region: "domestic", scope: "ai", ordering: "ranking", supported: true,
    sourceUrl: "https://www.aitop100.cn/artcenter/aivloglist.html", note: "按来源合集热度排序，保留原指标。" },
  { id: "hongguo-web", name: "红果热播榜 · 总热播", group: { id: "hongguo", name: "红果热播榜", category: "总热播" }, region: "domestic", scope: "market", ordering: "ranking", supported: true,
    sourceUrl: "https://hongguoduanju.com/rank/hot-drama", note: "官网总热播原始顺序，综合热度不是播放量。" },
  { id: "hongguo-real", name: "红果热播榜 · 真人剧", group: { id: "hongguo", name: "红果热播榜", category: "真人剧" }, region: "domestic", scope: "market", ordering: "ranking", supported: true,
    sourceUrl: "https://hongguoduanju.com/rank/hot-real-drama", note: "官网真人剧热播原始顺序，综合热度不是播放量。" },
  { id: "hongguo-comic", name: "红果热播榜 · 漫剧", group: { id: "hongguo", name: "红果热播榜", category: "漫剧" }, region: "domestic", scope: "market", ordering: "ranking", supported: true,
    sourceUrl: "https://hongguoduanju.com/rank/hot-comic-drama", note: "官网漫剧热播原始顺序，不把漫剧一律标作AI作品。" },
  { id: "hongguo-ai", name: "红果热播榜 · AI剧", group: { id: "hongguo", name: "红果热播榜", category: "AI剧" }, region: "domestic", scope: "ai", ordering: "ranking", supported: true,
    sourceUrl: "https://hongguoduanju.com/rank/hot-ai-drama", note: "官网AI剧分类及原始顺序，保留来源指标。" },
  { id: "lvpaopao", name: "绿泡泡短剧 · 今日必看", region: "domestic", scope: "market", ordering: "ranking", supported: false,
    sourceUrl: null, note: "暂未接入榜单数据；缺少可验证的公开或授权接口，等待后续配置。" },
  { id: "verticalcharts-52", name: "Vertical 52", region: "overseas", scope: "market", ordering: "ranking", supported: true, limit: 40,
    sourceUrl: "https://verticalcharts.com/charts/", note: "第三方短剧榜主榜前40；VertiScore不是播放量，也不是本站传播热度。使用范围以站方条款和实际授权为准。" },
  // Retired overseas sources keep their identities so old snapshots stay readable; they are no longer scheduled.
  { id: "pinedrama", name: "PineDrama", region: "overseas", scope: "market", ordering: "recommendation", supported: false, retired: true,
    sourceUrl: "https://shortdrama.tiktok.com/", note: "已由 Vertical Charts 单入口替代；旧历史保留。" },
  { id: "dramabox", name: "DramaBox · Trending", region: "overseas", scope: "market", ordering: "recommendation", supported: true, retired: true,
    sourceUrl: "https://www.dramabox.com/", note: "已由 Vertical Charts 单入口替代；只保留解析与旧历史，不再调度或展示导航。" },
  { id: "reelshort", name: "ReelShort · TOP", region: "overseas", scope: "market", ordering: "ranking", supported: true, retired: true,
    sourceUrl: "https://www.reelshort.com/shelf/top-short-movies-dramas-51000492", note: "已由 Vertical Charts 单入口替代；只保留解析与旧历史。" },
  { id: "netshort", name: "NetShort · Hot Series", region: "overseas", scope: "market", ordering: "ranking", supported: true, retired: true,
    sourceUrl: "https://netshort.com/hotseries", note: "已由 Vertical Charts 单入口替代；只保留解析与旧历史。" },
];
