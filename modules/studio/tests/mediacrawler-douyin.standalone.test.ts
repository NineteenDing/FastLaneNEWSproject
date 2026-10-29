import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";
import { douyinFixture, douyinCookie } from "./douyin-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("抖音使用原签名回复接口补一级评论的讨论，不把回复量或点赞当播放量", async () => {
  douyinFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture", cookie: douyinCookie });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 2); assert.equal(post.comments[1]!.parentExternalId, "comment-7600000000000000001");
  assert.equal(post.comments[1]!.text, "保留同一组角色参考，逐镜检查。");
  assert.equal(post.commentCoverage.replySample?.count, 1); assert.equal(post.commentCoverage.repliesComplete, false);
  assert.equal(post.metrics.views, 12000);
  transport.assertNoPendingInterceptors();
});

test("抖音原客户端和原JS签名取得资料、视频及图文简介、有界评论与续页，不冒充已转写", async () => {
  douyinFixture(transport);
  const result = await collectMediaCreator({ platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture", cookie: douyinCookie });
  assert.equal(result.profile.name, "AI镜头实验"); assert.equal(result.profile.followerCount, 8900); assert.equal(result.profile.workCount, 31);
  assert.equal(result.posts.length, 2);
  const video = result.posts[0], image = result.posts[1];
  assert.equal(video.kind, "video"); assert.equal(image.kind, "image_text");
  assert.equal(video.url, "https://www.douyin.com/video/7600000000000000001");
  assert.equal(image.url, "https://www.douyin.com/video/7600000000000000002", "沿用上游作品规范地址，不猜图文路径");
  assert.equal(video.text, "先固定角色，再做不同镜头。"); assert.equal(video.transcript, null);
  assert.equal(video.publishedAt, "2026-10-17T10:00:00Z"); assert.equal(video.metrics.views, 12000);
  assert.equal(video.metrics.likes, 520); assert.equal(video.metrics.favorites, 110);
  assert.equal(video.comments[0].text, "换景别以后角色会变吗？"); assert.equal(video.commentCoverage.complete, false);
  assert.equal(image.commentCoverage.complete, true); assert.equal(image.metrics.views, null);
  assert.equal(result.coverage.nextPage, 2); assert.equal(result.coverage.nextCursor, "1792200000000");
  assert.ok(!JSON.stringify(result).includes("private-"));
  transport.assertNoPendingInterceptors();
});

test("抖音缺少会话令牌与实际401/429分别显示待登录或限流，失败后释放浏览器", async () => {
  await assert.rejects(collectMediaCreator({ platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture" }),
    error => error instanceof MediaCrawlerFailure && error.code === "login_required");
  for (const [status, code] of [[401, "login_required"], [429, "rate_limited"]] as const) {
    douyinFixture(transport, { status });
    await assert.rejects(collectMediaCreator({ platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture", cookie: douyinCookie }),
      error => error instanceof MediaCrawlerFailure && error.code === code);
    transport.assertNoPendingInterceptors();
  }
});

test("抖音成功响应的末页空作品不会被当成平台故障", async () => {
  douyinFixture(transport, { empty: true });
  const result = await collectMediaCreator({ platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture", cookie: douyinCookie });
  assert.equal(result.profile.name, "AI镜头实验"); assert.deepEqual(result.posts, []);
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.nextPage, null);
  transport.assertNoPendingInterceptors();
});

test('有登录会话但缺SDK令牌时实际请求平台，不在本地误报账号失效',async()=>{
  const cookie=douyinCookie.split(';').filter(v=>!v.trim().startsWith('msToken=')).join(';');
  douyinFixture(transport,{cookie,empty:true});
  const result=await collectMediaCreator({platform:'douyin',locator:'MS4wLjABAAAAfilm_fixture',cookie,metadataOnly:true});
  assert.equal(result.profile.name,'AI镜头实验');
  transport.assertNoPendingInterceptors();
});

test('抖音实际19条单页含旧置顶时，首批取发布时间最新五条元数据，不请求评论',async()=>{
  douyinFixture(transport,{extraPosts:17,metadataOnly:true});
  const result=await collectMediaCreator({platform:'douyin',locator:'MS4wLjABAAAAfilm_fixture',cookie:douyinCookie,metadataOnly:true,metadataLimit:5});
  assert.deepEqual(result.posts.map(p=>p.externalId),['7600000000000000026','7600000000000000025','7600000000000000024','7600000000000000023','7600000000000000022']);
  assert.ok(result.posts.every(p=>p.comments.length===0));
  transport.assertNoPendingInterceptors();
});
