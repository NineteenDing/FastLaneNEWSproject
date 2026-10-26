import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";
import { bilibiliFixture, weiboFixture, xhsFixture } from "./mediacrawler-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("B站原二级评论接口补取回复并保留父评论，部分一级列表不冒充完整讨论", async () => {
  bilibiliFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "bilibili", locator: "20813884" });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 2);
  assert.equal(post.comments[1]!.text, "先固定参考图，再核对相邻镜头。");
  assert.equal(post.comments[1]!.parentExternalId, "99");
  assert.equal(post.commentCoverage.complete, false); assert.equal(post.commentCoverage.repliesComplete, false);
  assert.equal(post.commentCoverage.replySample?.count, 1); assert.equal(post.commentCoverage.replySample?.limit, 20);
  transport.assertNoPendingInterceptors();
});

test("固定MediaCrawler真实客户端通过受控HTTP读取B站资料、分页作品及有界评论，标明未完成范围", async () => {
  bilibiliFixture(transport, { workCount: 35 });
  const result = await collectMediaCreator({ platform: "bilibili", locator: "20813884" });
  assert.equal(result.profile.name, "影视流程研究");
  assert.equal(result.profile.workCount, 35);
  assert.equal(result.profile.followerCount, null, "未取得的粉丝数不填零");
  assert.equal(result.posts[0].url, "https://www.bilibili.com/video/BV1fixture");
  assert.equal(result.posts[0].text, "先锁定参考，再组织镜头");
  assert.equal(result.posts[0].metrics.views, 12000);
  assert.equal(result.posts[0].comments[0].text, "换镜头后怎么维持角色？");
  assert.equal(result.posts[0].commentCoverage.complete, false);
  assert.equal(result.posts[0].commentCoverage.repliesComplete, false);
  assert.equal(result.coverage.nextPage, 2);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.posts[0].transcript, null, "简介不能当作视频逐字稿");
  transport.assertNoPendingInterceptors();
});

test("回复采样每条作品最多两次补取和二十条回复，未访问或截断的父评论保留缺口", async () => {
  bilibiliFixture(transport, { replies: true, replyThreads: 3, replyCount: 15, rootsComplete: true });
  const result = await collectMediaCreator({ platform: "bilibili", locator: "20813884" });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 23);
  assert.equal(post.comments.filter(row => !row.parentExternalId).length, 3);
  assert.equal(post.comments.filter(row => row.parentExternalId === "99").length, 15);
  assert.equal(post.comments.filter(row => row.parentExternalId === "100").length, 5);
  assert.equal(post.comments.filter(row => row.parentExternalId === "101").length, 0);
  assert.deepEqual(post.commentCoverage, { complete: true, repliesComplete: false, limit: 20,
    replySample: { count: 20, limit: 20, parentsChecked: 1, parentsPending: 2, requests: 2 } });
  transport.assertNoPendingInterceptors();
});

test("平台限流返回明确状态，失败进程退出后可重试，不把错误页解析成空作品", async () => {
  for (const [status, payload, expected] of [[429, "slow down", "rate_limited"], [200, { code: -101, message: "private-login-error" }, "login_required"]] as const) {
    transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/nav" }).reply(status, payload);
    await assert.rejects(collectMediaCreator({ platform: "bilibili", locator: "20813884" }), error => error instanceof MediaCrawlerFailure && error.code === expected);
  }
  transport.assertNoPendingInterceptors();
});

test("单次作者采集回复补取总计不超过十二次，后续作品保留一级评论并标记回复待补", async () => {
  bilibiliFixture(transport, { replies: true, replyThreads: 2, replyCount: 15, copies: 7 });
  const result = await collectMediaCreator({ platform: "bilibili", locator: "20813884" });
  assert.equal(result.posts.length, 7);
  assert.equal(result.posts.slice(0, 6).reduce((sum, post) => sum + (post.commentCoverage.replySample?.requests ?? 0), 0), 12);
  assert.equal(result.posts[6]!.comments.length, 2);
  assert.deepEqual(result.posts[6]!.commentCoverage.replySample, { count: 0, limit: 20, parentsChecked: 0, parentsPending: 2, requests: 0 });
  assert.equal(result.posts[6]!.commentCoverage.repliesComplete, false);
  transport.assertNoPendingInterceptors();
});

test("微博原客户端取得作者、帖子全文和评论，保留独立互动指标与下一页游标", async () => {
  weiboFixture(transport);
  const result = await collectMediaCreator({ platform: "weibo", locator: "5756404150", cookie: "SUB=private-test-cookie" });
  assert.equal(result.profile.name, "影视工具观察"); assert.equal(result.profile.followerCount, 12340);
  assert.equal(result.posts[0].kind, "post");
  assert.equal(result.posts[0].text, "新功能让分镜更容易衔接 & 修改。");
  assert.equal(result.posts[0].metrics.likes, 120); assert.equal(result.posts[0].metrics.reposts, 9);
  assert.equal(result.posts[0].metrics.views, null, "点赞不能冒充播放");
  assert.equal(result.posts[0].publishedAt, "2026-10-17T10:00:00Z");
  assert.equal(result.posts[0].comments[0].text, "怎么保持场景一致？");
  assert.equal(result.posts[0].commentCoverage.complete, false);
  assert.equal(result.coverage.nextCursor, "5300000000000010");
  assert.equal(result.coverage.complete, false);
  assert.ok(!JSON.stringify(result).includes("private-test-cookie"));
  transport.assertNoPendingInterceptors();
});

test("小红书复用原主页解析与签名客户端取得完整笔记，保留图文类型和评论范围且不泄露分享令牌", async () => {
  const creator = "5eb8e1d400000000010075ae";
  xhsFixture(transport);
  const result = await collectMediaCreator({ platform: "xhs", locator: creator, cookie: "a1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; web_session=private-test-session",
    context: { xsec_token: "private-profile-token", xsec_source: "pc_share" } });
  assert.equal(result.profile.name, "漫剧制作手记"); assert.equal(result.profile.followerCount, 2300);
  assert.equal(result.posts[0].kind, "image_text"); assert.equal(result.posts[0].title, "多镜头角色一致性");
  assert.equal(result.posts[0].text, "先固定角色参考，再制作不同景别。");
  assert.equal(result.posts[0].metrics.favorites, 54); assert.equal(result.posts[0].metrics.likes, 108);
  assert.equal(result.posts[0].publishedAt, "2026-10-17T10:00:00Z");
  assert.equal(result.posts[0].comments[0].text, "参考图需要哪些角度？");
  assert.equal(result.posts[0].commentCoverage.complete, true);
  assert.equal(result.coverage.nextCursor, "next-notes-page"); assert.equal(result.coverage.complete, false);
  assert.ok(!JSON.stringify(result).includes("private-"));
  transport.assertNoPendingInterceptors();
});

test("微博复用原客户端的内嵌子评论保留父回复关系，HTML转正文且不额外访问无关接口", async () => {
  weiboFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "weibo", locator: "5756404150" });
  assert.equal(result.posts[0]!.comments.length, 2);
  assert.equal(result.posts[0]!.comments[1]!.parentExternalId, "90001");
  assert.equal(result.posts[0]!.comments[1]!.text, "先保存场景参考。");
  assert.equal(result.posts[0]!.commentCoverage.replySample?.requests, 0);
  assert.equal(result.posts[0]!.commentCoverage.repliesComplete, false);
  transport.assertNoPendingInterceptors();
});

test("小红书原子评论接口补齐预览外回复，重复预览去重，末页范围依据实际返回", async () => {
  xhsFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "xhs", locator: "5eb8e1d400000000010075ae",
    cookie: "a1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; web_session=private-test-session" });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 3);
  assert.deepEqual(post.comments.slice(1).map(row => row.parentExternalId), ["xhs-comment", "xhs-comment"]);
  assert.equal(post.comments[2]!.text, "再补一张背面参考。");
  assert.equal(post.commentCoverage.replySample?.count, 2); assert.equal(post.commentCoverage.replySample?.requests, 1);
  assert.equal(post.commentCoverage.repliesComplete, true);
  transport.assertNoPendingInterceptors();
});
