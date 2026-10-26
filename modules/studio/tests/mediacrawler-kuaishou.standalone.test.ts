import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";
import { kuaishouFixture, kuaishouCookie } from "./kuaishou-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("快手原REST V2二级评论按整数父ID读取，末页回复保留父子关系", async () => {
  kuaishouFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 2); assert.equal(post.comments[1]!.parentExternalId, "681");
  assert.equal(post.comments[1]!.text, "先做短镜头，再检查衔接。");
  assert.equal(post.commentCoverage.replySample?.count, 1); assert.equal(post.commentCoverage.repliesComplete, true);
  transport.assertNoPendingInterceptors();
});

test("快手原客户端通过原页面捕获脚本签名取得资料、REST作品与一级评论，保留分页和转写缺口", async () => {
  kuaishouFixture(transport);
  const result = await collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie });
  assert.equal(result.profile.name, "漫剧制作记录"); assert.equal(result.profile.followerCount, 9800); assert.equal(result.profile.workCount, 46);
  assert.equal(result.posts.length, 1);
  const post = result.posts[0];
  assert.equal(post.url, "https://www.kuaishou.com/short-video/3xfilmvideo");
  assert.equal(post.kind, "video"); assert.equal(post.text, "固定角色，再安排近景与远景。"); assert.equal(post.transcript, null);
  assert.equal(post.publishedAt, "2026-10-17T10:00:00Z"); assert.equal(post.metrics.views, 18500); assert.equal(post.metrics.likes, 620);
  assert.equal(post.comments[0].text, "长镜头怎么保证角色一致？"); assert.equal(post.commentCoverage.complete, true); assert.equal(post.commentCoverage.repliesComplete, false);
  assert.equal(result.coverage.nextPage, 2); assert.equal(result.coverage.nextCursor, "next-private-cursor");
  assert.ok(!JSON.stringify(result).includes("private-kuaishou"));
  transport.assertNoPendingInterceptors();
});

test("快手首次页面签名环境未就绪时保留上游一次重载，重新注入捕获脚本后完成采集", async () => {
  kuaishouFixture(transport, { reload: true, complete: true });
  const result = await collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie });
  assert.equal(result.posts[0].externalId, "3xfilmvideo"); assert.equal(result.coverage.complete, true);
  transport.assertNoPendingInterceptors();
});

test("快手401/429保留待登录和限流，失败后可重新采集原游标直至末页", async () => {
  for (const [status, code] of [[401, "login_required"], [429, "rate_limited"]] as const) {
    kuaishouFixture(transport, { status });
    await assert.rejects(collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie }),
      error => error instanceof MediaCrawlerFailure && error.code === code);
    transport.assertNoPendingInterceptors();
  }
  kuaishouFixture(transport, { cursor: "next-private-cursor", complete: true });
  const result = await collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie, page: 2, cursor: "next-private-cursor" });
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.nextPage, null); assert.equal(result.coverage.nextCursor, null);
  transport.assertNoPendingInterceptors();
});

test("快手HTTP200但result为2的已知业务限流保留限流分类，不显示为普通失败", async () => {
  kuaishouFixture(transport, { rateLimited: true });
  await assert.rejects(collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie }),
    error => error instanceof MediaCrawlerFailure && error.code === "rate_limited");
  transport.assertNoPendingInterceptors();
});

test("快手HTTP请求使用实际签名浏览器的User-Agent，不发送不完整的通用占位头", async () => {
  const isolated = new MockAgent(); isolated.disableNetConnect(); setGlobalDispatcher(isolated);
  try {
    kuaishouFixture(isolated, { complete: true, requireBrowserAgent: true });
    const result = await collectMediaCreator({ platform: "kuaishou", locator: "3xfilmfixture", cookie: kuaishouCookie });
    assert.equal(result.posts.length, 1); isolated.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(transport); await isolated.close(); }
});
