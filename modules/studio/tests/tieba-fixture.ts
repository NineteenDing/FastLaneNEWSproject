import type { MockAgent } from "undici";

/** Actual PC response shapes consumed by the fixed upstream Tieba client/extractor. */
export function tiebaFixture(transport: MockAgent, options: { page?: number; complete?: boolean; hasMore?: boolean; missingHasMore?: boolean; status?: number; single?: boolean; replies?: boolean } = {}) {
  const api = transport.get("https://tieba.baidu.com"), headers = { cookie: "BDUSS=private-tieba-cookie" };
  const signed = (value: string, pathname: string) => {
    const url = new URL(value, "https://tieba.baidu.com");
    return url.pathname === pathname && /^[0-9a-f]{32}$/.test(url.searchParams.get("sign") ?? "");
  };
  api.intercept({ path: "/", headers }).reply(200, "<html><body>origin</body></html>", { headers: { "content-type": "text/html" } });
  if (!options.single) {
  api.intercept({ path: (value: string) => signed(value, "/c/u/pc/homeSidebarRight") && new URL(value, "https://tieba.baidu.com").searchParams.get("portrait") === "tb.fixture", headers })
    .reply(options.status ?? 200, { error_code: 0, data: { user: { id: "82001", portrait: "tb.fixture", name_show: "漫剧镜头研究", intro: "记录制作与镜头实验", fans_num: "321", thread_num: "25" } } });
  if (options.status && options.status !== 200) return;
  api.intercept({ path: (value: string) => signed(value, "/c/u/feed/myThread") && new URL(value, "https://tieba.baidu.com").searchParams.get("pn") === String(options.page ?? 1), headers })
    .reply(200, { error_code: 0, data: { ...(options.missingHasMore ? {} : { has_more: options.hasMore ?? (options.complete ? 0 : 1) }), list: [{ thread_info: { tid: "99001" } }] } });
  if (options.missingHasMore) return;
  }
  api.intercept({ path: (value: string) => signed(value, "/c/s/pc/sync"), headers }).reply(200, { error_code: 0, data: { anti: { tbs: "private-tieba-tbs" } } });
  api.intercept({ path: "/c/f/pb/page_pc", method: "POST", headers,
    body: value => { const body = new URLSearchParams(Buffer.from(value).toString("utf8")); return body.get("kz") === "99001" && body.get("pn") === "1" && body.get("tbs") === "private-tieba-tbs" && /^[0-9a-f]{32}$/.test(body.get("sign") ?? ""); } })
    .reply(200, { error_code: 0, thread: { id: "99001", title: "角色一致性的镜头安排", reply_num: 23, create_time: 1792231200 }, forum: { id: "22001", name: "AI影视" },
      first_floor: { id: "50001", tid: "99001", author_id: "82001", content: [{ text: "先锁定角色参考，再切换不同景别。" }], time: 1792231200 },
      page: { current_page: 1, total_page: 2 }, user_list: [{ id: "82001", portrait: "tb.fixture", name_show: "漫剧镜头研究" }, { id: "82002", portrait: "tb.reader", name_show: "读者" }],
      post_list: [{ id: "50001", post_no: 1, author_id: "82001", content: [{ text: "先锁定角色参考，再切换不同景别。" }], time: 1792231200 },
        { id: "50002", post_no: 2, author_id: "82002", content: [{ text: "换角度时参考强度怎么调？" }], time: 1792231300, sub_post_number: options.replies ? 1 : 4 }] });
  api.intercept({ path: value => { const url = new URL(value, "https://tieba.baidu.com");
    return url.pathname === "/p/comment" && url.searchParams.get("tid") === "99001" && url.searchParams.get("pid") === "50002"
      && url.searchParams.get("fid") === "22001" && url.searchParams.get("pn") === "1"; }, headers })
    .reply(200, options.replies ? '<ul><li class="lzl_single_post j_lzl_s_p" data-field="{&quot;spid&quot;:50003,&quot;showname&quot;:&quot;创作读者&quot;}"><a class="j_user_card lzl_p_p" href="/home/main?id=tb.reader">读者</a><span class="lzl_content_main">先用固定机位做一次对照，再改参考强度。</span><span class="lzl_time">2026-10-17 18:10</span></li></ul>' : '<ul></ul>',
      { headers: { "content-type": "text/html; charset=utf-8" } });
}
