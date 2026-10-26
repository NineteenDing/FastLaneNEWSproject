import type { MockAgent } from "undici";

export function zhihuFixture(transport: MockAgent, options: { answerOffset?: number; answersComplete?: boolean; articlesFinished?: boolean; zeroComments?: boolean; replies?: boolean; locator?: string; stableId?: string; body?: string } = {}) {
  const api = transport.get("https://www.zhihu.com");
  const locator = options.locator ?? "film-creator", stableId = options.stableId ?? "creator-stable-id";
  const headers = { cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login", "x-zse-93": "101_3_3.0", "x-zse-96": /^2\.0_/, "x-zst-81": /^3_2\.0/ };
  const profile = { initialState: { entities: { users: { [locator]: {
    id: stableId, urlToken: locator, name: "影视创作实验室", headline: "记录分镜与制作工具", avatarUrl: "https://picx.zhimg.com/avatar.jpg",
    followerCount: 5600, answerCount: 21, articlesCount: 8, zvideoCount: 0,
  } } } } };
  api.intercept({ path: "/people/" + locator, headers }).reply(200, `<html><script id="js-initialData" type="text/json">${JSON.stringify(profile)}</script></html>`);
  api.intercept({ path: (value: string) => value.startsWith(`/api/v4/members/${locator}/answers?`)
    && new URL(value, "https://www.zhihu.com").searchParams.get("offset") === String(options.answerOffset ?? 0), headers })
    .reply(200, { paging: { is_end: !!options.answersComplete }, data: [{ type: "answer", id: 88001, author: { id: stableId, url_token: locator },
      question: { id: 77001, title: "如何保持不同镜头里的角色一致？" }, content: options.body ?? "<p>先锁定<b>角色参考</b>，再安排镜头。</p>", created_time: 1792231200, voteup_count: 218, comment_count: options.zeroComments ? 0 : 12 }] });
  if (!options.articlesFinished) {
    api.intercept({ path: (value: string) => value.startsWith(`/api/v4/members/${locator}/articles?`), headers }).reply(200, { paging: { is_end: true }, data: [{ type: "article", id: 88001,
      author: { id: stableId, url_token: locator }, title: "把分镜接成一条制作流程", content: "<p>把每个镜头的输入和检查点列清楚。</p>", created: 1792231500,
      voteup_count: 91, comment_count: options.zeroComments ? 0 : 3, column: { id: "ai-film", title: "AI影视制作", url: "https://zhuanlan.zhihu.com/ai-film" } }] });
    if (!options.zeroComments) api.intercept({ path: /^\/api\/v4\/comment_v5\/articles\/88001\/root_comment\?/, headers }).reply(200, { paging: { is_end: true }, data: [
      { id: 55002, content: "<p>能给一个检查清单吗？</p>", like_count: 6, created_time: 1792231700 },
    ] });
  }
  if (!options.zeroComments) api.intercept({ path: /^\/api\/v4\/comment_v5\/answers\/88001\/root_comment\?/, headers }).reply(200, { paging: { is_end: false }, data: [
    { id: 55001, content: "<p>参考图需要几个角度？</p>", like_count: 11, created_time: 1792231300, ...(options.replies ? { child_comment_count: 1 } : {}) },
  ] });
  if (options.replies) api.intercept({ path: /^\/api\/v4\/comment_v5\/comment\/55001\/child_comment\?/, headers }).reply(200, { paging: { is_end: true }, data: [
    { id: 55003, content: "<p>关键是<b>固定特征</b>，并保持输入一致。</p>", like_count: 2, created_time: 1792231400 },
  ] });
}

/** External platform responses only; every test retains its own observable expectations. */
export function bilibiliFixture(transport: MockAgent, options: { views?: number | null; workCount?: number; description?: string; onRead?: () => void; copies?: number; bvid?: string; avatar?: string; replies?: boolean; replyThreads?: number; replyCount?: number; rootsComplete?: boolean } = {}) {
  const api = transport.get("https://api.bilibili.com");
  const nav = api.intercept({ path: "/x/web-interface/nav" }).reply(() => { options.onRead?.(); return { statusCode: 200, data: { code: 0, data: { wbi_img: {
    img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
    sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } } }; });
  if (options.onRead) nav.delay(300);
  api.intercept({ path: /^\/x\/space\/wbi\/acc\/info\?/ }).reply(200, { code: 0, data: { mid: 20813884, name: "影视流程研究", sign: "分享镜头与制作流程", face: options.avatar ?? null } });
  api.intercept({ path: /^\/x\/space\/wbi\/arc\/search\?/ }).reply(200, { code: 0, data: { page: { pn: 1, ps: 30, count: options.workCount ?? 1 }, list: { vlist: Array.from({ length: options.copies ?? 1 }, () =>
    ({ aid: 12345, bvid: options.bvid ?? "BV1fixture", title: "角色一致性的方法", description: options.description ?? "先锁定参考，再组织镜头", created: 1792231200, play: options.views === undefined ? 12000 : options.views, comment: 80 })),
  } } });
  api.intercept({ path: /^\/x\/v2\/reply\/wbi\/main\?/ }).reply(200, { code: 0, data: { cursor: { is_end: !!options.rootsComplete, next: 20 }, replies:
    Array.from({ length: options.replyThreads ?? 1 }, (_, index) => ({ rpid: 99 + index, ctime: 1792231300, like: 12,
      content: { message: "换镜头后怎么维持角色？" }, replies: [], ...(options.replies ? { rcount: options.replyCount ?? 1 } : {}) })),
  } }).times(options.copies ?? 1);
  if (options.replies) for (let index = 0; index < Math.min(options.replyThreads ?? 1, 2); index++) {
    api.intercept({ path: (value: string) => value.startsWith("/x/v2/reply/reply?")
      && new URL(value, "https://api.bilibili.com").searchParams.get("root") === String(99 + index) }).reply(200, { code: 0, data: {
      page: { num: 1, size: 20, count: options.replyCount ?? 1 }, replies: Array.from({ length: options.replyCount ?? 1 }, (_, child) =>
        ({ rpid: options.replyThreads ? 1000 + index * 100 + child : 100, root: 99 + index, ctime: 1792231400, like: 4,
          content: { message: "先固定参考图，再核对相邻镜头。" } })),
    } }).times(Math.min(options.copies ?? 1, 6));
  }
}

export function weiboFixture(transport: MockAgent, options: { expectedCookie?: string; expectedCursor?: string; complete?: boolean; onRead?: () => void; video?: boolean; text?: string; replies?: boolean; postId?: string } = {}) {
  const api = transport.get("https://m.weibo.cn"), headers = options.expectedCookie ? { cookie: options.expectedCookie } : undefined;
  const profile = api.intercept({ path: (value: string) => value.startsWith("/api/container/getIndex?") && value.includes("containerid=1005055756404150"), headers })
    .reply(() => { options.onRead?.(); return { statusCode: 200, data: { ok: 1, data: { userInfo: { id: 5756404150, screen_name: "影视工具观察", description: "关注制作工作流", followers_count: 12340, statuses_count: 28, profile_image_url: null } } } }; });
  if (options.onRead) profile.delay(300);
  api.intercept({ path: (value: string) => value.startsWith("/api/container/getIndex?") && value.includes("containerid=1076035756404150")
    && (options.expectedCursor === undefined || new URL(value, "https://m.weibo.cn").searchParams.get("since_id") === options.expectedCursor), headers })
    .reply(200, { ok: 1, data: { cardlistInfo: { since_id: options.complete ? "0" : "5300000000000010", total: 28 }, cards: [{ card_type: 9, mblog: {
      id: options.postId ?? "5300000000000011", text: options.text ?? "<p>新功能让<b>分镜</b>更容易衔接 &amp; 修改。</p>", created_at: "Sat Oct 17 18:00:00 +0800 2026",
      attitudes_count: 120, comments_count: 33, reposts_count: 9, isLongText: false, user: { id: 5756404150 },
      ...(options.video ? { page_info: { type: "video", media_info: { mp4_720p_mp4: "https://f.video.weibocdn.com/fixture-video.mp4" } } } : {}),
    } }] } });
  api.intercept({ path: /^\/comments\/hotflow\?/, headers }).reply(200, { ok: 1, data: { max_id: 42, data: [
    { id: "90001", text: "怎么保持<b>场景一致</b>？", like_count: 8, created_at: "Sat Oct 17 18:05:00 +0800 2026",
      ...(options.replies ? { total_number: 1, comments: [{ id: "90002", text: "先保存<b>场景参考</b>。", like_count: 2, created_at: "Sat Oct 17 18:06:00 +0800 2026" }] } : {}) },
  ] } });
}

export function weiboVideoDetailFixture(transport: MockAgent, options: { owner?: string; id?: string; text?: string; url?: string } = {}) {
  const item = { id: options.id ?? "5300000000000011", text: options.text ?? "<p>新功能让<b>分镜</b>更容易衔接 &amp; 修改。</p>", user: { id: options.owner ?? "5756404150" },
    page_info: { type: "video", media_info: { mp4_720p_mp4: options.url ?? "https://f.video.weibocdn.com/fixture-video.mp4" } } };
  transport.get("https://m.weibo.cn").intercept({ path: "/detail/5300000000000011" })
    .reply(200, `<script>var $render_data = ${JSON.stringify([{ status: item }])}[0]</script>`, { headers: { "content-type": "text/html" } });
}

export function xhsFixture(transport: MockAgent, options: { expectedCookie?: string; expectedCursor?: string; complete?: boolean; video?: boolean; text?: string; videoStreams?: { master_url: string; height: number }[]; replies?: boolean } = {}) {
  const creator = "5eb8e1d400000000010075ae", note = "670000000000000001234567";
  const headers = options.expectedCookie ? { cookie: options.expectedCookie } : undefined;
  const state = { user: { userPageData: { basicInfo: { nickname: "漫剧制作手记", desc: "记录实际制作方法", images: "https://sns-avatar.xhscdn.com/avatar.jpg" }, interactions: [{ type: "fans", count: "2300" }] } } };
  transport.get("https://www.xiaohongshu.com").intercept({ path: (value: string) => value.startsWith(`/user/profile/${creator}`), headers })
    .reply(200, `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script></html>`, { headers: { "content-type": "text/html" } });
  const api = transport.get("https://edith.xiaohongshu.com");
  api.intercept({ path: (value: string) => value.startsWith("/api/sns/web/v1/user_posted?")
    && (options.expectedCursor === undefined || new URL(value, "https://edith.xiaohongshu.com").searchParams.get("cursor") === options.expectedCursor), headers })
    .reply(200, { success: true, code: 0, data: { has_more: !options.complete, cursor: options.complete ? "" : "next-notes-page", notes: [
      { note_id: note, xsec_token: "private-note-token", xsec_source: "pc_feed" },
    ] } });
  api.intercept({ path: "/api/sns/web/v1/feed", method: "POST", headers }).reply(200, { success: true, code: 0, data: { items: [{ note_card: {
    note_id: note, type: options.video ? "video" : "normal", title: "多镜头角色一致性", desc: options.text ?? "先固定角色参考，再制作不同景别。", time: 1792231200000,
    ...(options.video ? { video: { consumer: { origin_video_key: "fixture-origin.mp4" }, ...(options.videoStreams ? { media: { stream: { h264: options.videoStreams } } } : {}) } } : {}),
    user: { user_id: creator }, interact_info: { liked_count: "108", comment_count: "25", collected_count: "54", share_count: "7" },
  } }] } });
  api.intercept({ path: /^\/api\/sns\/web\/v2\/comment\/page\?/, headers }).reply(200, { success: true, code: 0, data: { has_more: false, comments: [
    { id: "xhs-comment", content: "参考图需要哪些角度？", like_count: "9", create_time: 1792231300000,
      ...(options.replies ? { sub_comment_count: "2", sub_comments: [{ id: "xhs-reply-1", content: "先准备正面和侧面。", like_count: "2", create_time: 1792231400000 }] } : {}) },
  ] } });
  if (options.replies) api.intercept({ path: (value: string) => value.startsWith("/api/sns/web/v2/comment/sub/page?")
    && new URL(value, "https://edith.xiaohongshu.com").searchParams.get("root_comment_id") === "xhs-comment", headers })
    .reply(200, { success: true, code: 0, data: { has_more: false, comments: [
      { id: "xhs-reply-1", content: "先准备正面和侧面。", like_count: "2", create_time: 1792231400000 },
      { id: "xhs-reply-2", content: "再补一张背面参考。", like_count: "1", create_time: 1792231500000 },
    ] } });
}

/** Only the designated note response; intentionally no profile/list/comment interceptors. */
export function xhsVideoDetailFixture(transport: MockAgent, options: { key?: string; videoStreams?: { master_url: string; height: number }[]; calls?: number; owner?: string; note?: string; source?: string } = {}) {
  transport.get("https://edith.xiaohongshu.com").intercept({ path: "/api/sns/web/v1/feed", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8")); return body.source_note_id === "670000000000000001234567" && body.xsec_token === "private-note-token" && body.xsec_source === (options.source ?? "pc_feed");
  } }).reply(200, { success: true, code: 0, data: { items: [{ note_card: {
    note_id: options.note ?? "670000000000000001234567", type: "video", title: "多镜头角色一致性", desc: "先固定角色参考，再制作不同景别。",
    user: { user_id: options.owner ?? "5eb8e1d400000000010075ae" }, video: { consumer: { origin_video_key: options.key ?? "fixture-origin.mp4" },
      ...(options.videoStreams ? { media: { stream: { h264: options.videoStreams } } } : {}) },
  } }] } }).times(options.calls ?? 1);
}
