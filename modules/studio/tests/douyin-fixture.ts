import type { MockAgent } from "undici";

export const douyinCookie = "sessionid=private-douyin-session; msToken=private-douyin-ms-token; UIFID=private-douyin-uifid; s_v_web_id=private-douyin-fp";
export function douyinFixture(transport: MockAgent, options: { cursor?: string; complete?: boolean; status?: number; empty?: boolean; media?: boolean; replies?: boolean; cookie?:string; extraPosts?:number; metadataOnly?:boolean } = {}) {
  const cookie=options.cookie ?? douyinCookie;
  const token=cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('msToken='))?.slice(8) ?? '';
  const api = transport.get("https://www.douyin.com");
  api.intercept({ path: "/", headers: { cookie } }).reply(200, "<html><body>platform origin</body></html>", { headers: { "content-type": "text/html" } });
  const signed = (value: string, pathname: string) => {
    const url = new URL(value, "https://www.douyin.com");
    return url.pathname === pathname && (url.searchParams.get("a_bogus")?.length ?? 0) > 100 && url.searchParams.get("msToken") === token;
  };
  const headers = { cookie, "x-tt-argus": "1", uifid: "private-douyin-uifid" };
  api.intercept({ path: value => signed(value, "/aweme/v1/web/user/profile/other/") && new URL(value, "https://www.douyin.com").searchParams.get("sec_user_id") === "MS4wLjABAAAAfilm_fixture", headers })
    .reply(options.status ?? 200, { status_code: 0, user: { sec_uid: "MS4wLjABAAAAfilm_fixture", nickname: "AI镜头实验", signature: "记录漫剧制作过程", follower_count: 8900, aweme_count: 31, avatar_thumb: { url_list: ["https://p3.douyinpic.com/avatar.jpg"] } } });
  if (options.status && options.status !== 200) return;
  api.intercept({ path: value => signed(value, "/aweme/v1/web/aweme/post/") && new URL(value, "https://www.douyin.com").searchParams.get("max_cursor") === (options.cursor ?? ""), headers })
    .reply(200, { status_code: 0, has_more: options.complete || options.empty ? 0 : 1, max_cursor: options.complete || options.empty ? "0" : "1792200000000", aweme_list: options.empty ? null : [
      { aweme_id: "7600000000000000001", aweme_type: 0, author: { sec_uid: "MS4wLjABAAAAfilm_fixture" }, desc: "先固定角色，再做不同镜头。", create_time: 1792231200, statistics: { play_count: 12000, comment_count: 80, digg_count: 520, share_count: 32, collect_count: 110 },
        ...(options.media ? { video: { play_addr_h264: { url_list: ["https://v3-dy-o.zjcdn.com/fixture-video.mp4"] } } } : {}) },
      { aweme_id: "7600000000000000002", aweme_type: 68, author: { sec_uid: "MS4wLjABAAAAfilm_fixture" }, desc: "图文展示分镜参考和检查点。", images: [{ uri: "source-frame" }], create_time: 1792231500, statistics: { comment_count: 2, digg_count: 61, collect_count: 27 } },
      ...Array.from({length:options.extraPosts??0},(_,i)=>({aweme_id:String(7600000000000000010n+BigInt(i)),author:{sec_uid:'MS4wLjABAAAAfilm_fixture'},desc:'AI场景一致性教程',create_time:1793145600+i,statistics:{digg_count:100+i}})),
    ] });
  if (options.empty || options.metadataOnly) return;
  for (const [identity, comment, more] of [["7600000000000000001", "换景别以后角色会变吗？", 1], ["7600000000000000002", "检查点能做成清单吗？", 0]] as const) {
    api.intercept({ path: value => signed(value, "/aweme/v1/web/comment/list/") && new URL(value, "https://www.douyin.com").searchParams.get("aweme_id") === identity, headers })
      .reply(200, { status_code: 0, has_more: more, cursor: 20, comments: [{ cid: "comment-" + identity, text: comment, digg_count: 8, create_time: 1792231800,
        ...(options.replies ? { reply_comment_total: more ? 1 : 0 } : {}) }] });
  }
  if (options.replies) api.intercept({ path: value => signed(value, "/aweme/v1/web/comment/list/reply/")
    && new URL(value, "https://www.douyin.com").searchParams.get("comment_id") === "comment-7600000000000000001", headers })
    .reply(200, { status_code: 0, has_more: 0, comments: [{ cid: "douyin-reply", text: "保留同一组角色参考，逐镜检查。", digg_count: 3, create_time: 1792231900 }] });
}

/** Designated detail only; no profile/list/comments can accidentally satisfy this fixture. */
export function douyinVideoDetailFixture(transport: MockAgent, options: { owner?: string; id?: string; url?: string } = {}) {
  const api = transport.get("https://www.douyin.com");
  api.intercept({ path: "/", headers: { cookie: douyinCookie } }).reply(200, "<html><body>platform origin</body></html>", { headers: { "content-type": "text/html" } });
  api.intercept({ path: value => {
    const url = new URL(value, "https://www.douyin.com");
    return url.pathname === "/aweme/v1/web/aweme/detail/" && url.searchParams.get("aweme_id") === "7600000000000000001"
      && url.searchParams.get("uifid") === "private-douyin-uifid" && url.searchParams.get("fp") === "private-douyin-fp"
      && url.searchParams.get("verifyFp") === "private-douyin-fp" && url.searchParams.get("msToken") === "private-douyin-ms-token"
      && (url.searchParams.get("a_bogus")?.length ?? 0) > 100;
  }, headers: headers => headers.cookie === douyinCookie && headers.origin === undefined && /Chrome\/\d/.test(String(headers["user-agent"])) })
    .reply(200, { status_code: 0, aweme_detail: { aweme_id: options.id ?? "7600000000000000001", author: { sec_uid: options.owner ?? "MS4wLjABAAAAfilm_fixture" },
      desc: "先固定角色，再做不同镜头。", video: { play_addr_h264: { url_list: [options.url ?? "https://v3-dy-o.zjcdn.com/fixture-video.mp4"] } } } });
}
