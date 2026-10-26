import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";
import { tiebaFixture } from "./tieba-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("贴吧楼中楼复用原HTML提取器，父回帖和楼层保留，未知回复时间不伪造", async () => {
  tiebaFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "tieba", locator: "tb.fixture", cookie: "BDUSS=private-tieba-cookie" });
  const post = result.posts[0]!;
  assert.equal(post.comments.length, 2); assert.equal(post.comments[0]!.floor, 2);
  assert.equal(post.comments[1]!.parentExternalId, "50002"); assert.equal(post.comments[1]!.externalId, "50003");
  assert.equal(post.comments[1]!.text, "先用固定机位做一次对照，再改参考强度。");
  assert.equal(post.comments[1]!.publishedAt, null);
  assert.equal(post.commentCoverage.replySample?.count, 1); assert.equal(post.commentCoverage.repliesComplete, false);
  transport.assertNoPendingInterceptors();
});

test("贴吧原PC客户端经真实受控浏览器读取作者、帖子和楼层回帖，分页与回复缺口如实保留", async () => {
  tiebaFixture(transport);
  const result = await collectMediaCreator({ platform: "tieba", locator: "tb.fixture", cookie: "BDUSS=private-tieba-cookie" });
  assert.equal(result.profile.name, "漫剧镜头研究"); assert.equal(result.profile.followerCount, 321);
  assert.equal(result.profile.workCount, 25);
  const post = result.posts[0];
  assert.equal(post.kind, "post"); assert.equal(post.url, "https://tieba.baidu.com/p/99001");
  assert.equal(post.text, "先锁定角色参考，再切换不同景别。");
  assert.equal(post.publishedAt, "2026-10-17T10:00:00Z"); assert.equal(post.metrics.comments, 23); assert.equal(post.metrics.views, null);
  assert.equal(post.comments.length, 1, "首楼正文不能重复作为读者评论");
  assert.equal(post.comments[0].text, "换角度时参考强度怎么调？");
  assert.equal(post.comments[0].floor, 2); assert.equal(post.comments[0].externalId, "50002");
  assert.equal(post.commentCoverage.complete, false); assert.equal(post.commentCoverage.repliesComplete, false);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.nextPage, 2);
  assert.ok(!JSON.stringify(result).includes("private-"));
  transport.assertNoPendingInterceptors();
});

test("贴吧会话失效、平台限流与分页信息缺失均不冒充成功空列表，进程退出后仍可继续", async () => {
  for (const [status, code] of [[401, "login_required"], [429, "rate_limited"]] as const) {
    tiebaFixture(transport, { status });
    await assert.rejects(collectMediaCreator({ platform: "tieba", locator: "tb.fixture", cookie: "BDUSS=private-tieba-cookie" }),
      error => error instanceof MediaCrawlerFailure && error.code === code);
    transport.assertNoPendingInterceptors();
  }
  tiebaFixture(transport, { missingHasMore: true });
  await assert.rejects(collectMediaCreator({ platform: "tieba", locator: "tb.fixture", cookie: "BDUSS=private-tieba-cookie" }),
    error => error instanceof MediaCrawlerFailure && error.code === "platform_failed");
  transport.assertNoPendingInterceptors();
  tiebaFixture(transport, { page: 2, complete: true });
  const result = await collectMediaCreator({ platform: "tieba", locator: "tb.fixture", page: 2, cookie: "BDUSS=private-tieba-cookie" });
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.nextPage, null);
  transport.assertNoPendingInterceptors();
});

test("贴吧返回布尔末页标记时结束续页，不把false字符串化为仍有下一页", async () => {
  tiebaFixture(transport, { hasMore: false });
  const result = await collectMediaCreator({ platform: "tieba", locator: "tb.fixture", cookie: "BDUSS=private-tieba-cookie" });
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.nextPage, null);
  transport.assertNoPendingInterceptors();
});
