import type { MockAgent } from "undici";

export const kuaishouCookie = "kuaishou.server.web_st=private-kuaishou-session; did=private-kuaishou-device";
/** External page SDK is a boundary fixture. Production uses the real site SDK, never this code. */
export function kuaishouFixture(transport: MockAgent, options: { cursor?: string; complete?: boolean; status?: number; reload?: boolean; rateLimited?: boolean; requireBrowserAgent?: boolean; media?: boolean; replies?: boolean } = {}) {
  const api = transport.get("https://www.kuaishou.com");
  if (options.reload) api.intercept({ path: "/?isHome=1", headers: { cookie: kuaishouCookie } }).reply(200,
    "<html><body>SDK not ready on first document</body></html>", { headers: { "content-type": "text/html" } });
  api.intercept({ path: "/?isHome=1", headers: { cookie: kuaishouCookie } }).reply(200,
    `<html><script>
      const realm = { $encode() {}, $getCatVersion() {}, call(name, args) {
        const input = args[0];
        if(name !== '$encode' || input.url !== '/rest/v/profile/feed' || input.query.caver !== 2 || input.requestBody.user_id !== '3xfilmfixture') throw new Error('unexpected signature');
        args[1].suc('fixture-page-signature');
      }};
      realm.caver = 2;
    </script><body>External SDK boundary fixture</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  api.intercept({ path: "/graphql", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8"));
    return body.operationName === "visionProfile" && body.variables.userId === "3xfilmfixture" && body.query.includes("ownerCount");
  }, headers: headers => headers.cookie === kuaishouCookie && (!options.requireBrowserAgent || /Chrome\/\d/.test(String(headers["user-agent"]))) }).reply(options.status ?? 200, { data: { visionProfile: { result: 1, userProfile: {
    ownerCount: { fan: 9800, photo: 46 }, profile: { user_id: "3xfilmfixture", user_name: "漫剧制作记录", user_text: "分享角色和镜头实操" },
  } } } });
  if (options.status && options.status !== 200) return;
  if (options.rateLimited) {
    api.intercept({ path: "/rest/v/profile/feed?__NS_hxfalcon=fixture-page-signature&caver=2", method: "POST", headers: { cookie: kuaishouCookie } })
      .reply(200, { result: 2, error_msg: "private-business-limit" }).persist();
    return;
  }
  api.intercept({ path: "/rest/v/profile/feed?__NS_hxfalcon=fixture-page-signature&caver=2", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8"));
    return body.user_id === "3xfilmfixture" && body.pcursor === (options.cursor ?? "") && body.page === "profile";
  }, headers: { cookie: kuaishouCookie } }).reply(200, { result: 1, pcursor: options.complete ? "no_more" : "next-private-cursor", feeds: [{
    type: "video", author: { id: "3xfilmfixture", name: "漫剧制作记录" },
    photo: { id: "3xfilmvideo", caption: "固定角色，再安排近景与远景。", timestamp: 1792231200000, realLikeCount: 620, viewCount: 18500,
      ...(options.media ? { photoUrl: "https://v.kwaicdn.com/fixture-video.mp4" } : {}) },
  }] });
  api.intercept({ path: "/rest/v/photo/comment/list", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8")); return body.photoId === "3xfilmvideo" && body.pcursor === "";
  }, headers: { cookie: kuaishouCookie } }).reply(200, { result: 1, pcursorV2: "no_more", commentCountV2: 1,
    rootCommentsV2: [{ comment_id: 681, content: "长镜头怎么保证角色一致？", timestamp: 1792231800000, ...(options.replies ? { hasSubComments: true } : {}) }] });
  if (options.replies) api.intercept({ path: "/rest/v/photo/comment/sublist", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8")); return body.photoId === "3xfilmvideo" && body.rootCommentId === 681 && body.pcursor === "";
  }, headers: { cookie: kuaishouCookie } }).reply(200, { result: 1, pcursorV2: "no_more", subCommentsV2: [
    { comment_id: 682, content: "先做短镜头，再检查衔接。", timestamp: 1792231900000 },
  ] });
}

export function kuaishouVideoDetailFixture(transport: MockAgent, options: { owner?: string; id?: string; url?: string; unavailable?: boolean; searchTerm?: string } = {}) {
  const api = transport.get("https://www.kuaishou.com");
  const page = options.searchTerm ? `<html><script>
    const realm = { $encode() {}, $getCatVersion() {}, call(name, args) {
      const input = args[0];
      if(name !== '$encode' || input.url !== '/rest/v/search/feed' || input.query.caver !== 2 || input.requestBody.keyword !== ${JSON.stringify(options.searchTerm)}) throw new Error('unexpected search signature');
      args[1].suc('fixture-search-signature');
    }}; realm.caver = 2;
  </script><body>External search SDK boundary fixture</body></html>` : "<html><body>platform origin</body></html>";
  api.intercept({ path: "/?isHome=1", headers: { cookie: kuaishouCookie } }).reply(200, page, { headers: { "content-type": "text/html; charset=utf-8" } });
  api.intercept({ path: "/graphql", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8")); return body.operationName === "visionVideoDetail" && body.variables.photoId === "3xfilmvideo"
      && body.variables.page === "search" && body.query.includes("manifestH265");
  }, headers: headers => headers.cookie === kuaishouCookie && /Chrome\/\d/.test(String(headers["user-agent"])) })
    .reply(200, { data: { visionVideoDetail: options.unavailable ? { photo: null, author: null } : {
      author: { id: options.owner ?? "3xfilmfixture", name: "漫剧制作记录" }, photo: { id: options.id ?? "3xfilmvideo",
        caption: "固定角色，再安排近景与远景。", photoUrl: options.url ?? "https://v.kwaicdn.com/fixture-video.mp4" },
    } } });
}
