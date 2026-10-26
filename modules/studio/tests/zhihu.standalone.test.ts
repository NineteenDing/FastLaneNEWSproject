import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";
import { zhihuFixture } from "./mediacrawler-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("知乎通过原签名子评论接口保留回答回复的父子关系", async () => {
  zhihuFixture(transport, { replies: true });
  const result = await collectMediaCreator({ platform: "zhihu", locator: "film-creator", cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login" });
  const post = result.posts.find(item => item.kind === "answer")!;
  assert.equal(post.comments.length, 2); assert.equal(post.comments[1]!.parentExternalId, "55001");
  assert.equal(post.comments[1]!.text, "关键是固定特征，并保持输入一致。");
  assert.equal(post.commentCoverage.replySample?.count, 1); assert.equal(post.commentCoverage.replySample?.requests, 1);
  assert.equal(post.commentCoverage.repliesComplete, false);
  transport.assertNoPendingInterceptors();
});

test("知乎使用原客户端及真实签名同时读取回答与文章，保留问题专栏关系且同数字ID不混合", async () => {
  zhihuFixture(transport);
  const result = await collectMediaCreator({ platform: "zhihu", locator: "film-creator", cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login" });
  assert.equal(result.profile.name, "影视创作实验室"); assert.equal(result.profile.followerCount, 5600);
  assert.equal(result.profile.stableId, "creator-stable-id");
  assert.equal(result.profile.canonicalLocator, "film-creator");
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.posts.map(post => post.externalId), ["answer:88001", "article:88001"]);
  assert.equal(result.posts[0].kind, "answer"); assert.equal(result.posts[1].kind, "article");
  assert.equal(result.posts[0].title, "如何保持不同镜头里的角色一致？");
  assert.equal(result.posts[0].text, "先锁定角色参考，再安排镜头。");
  assert.equal(result.posts[0].url, "https://www.zhihu.com/question/77001/answer/88001");
  assert.deepEqual(result.posts[0].parent, { kind: "question", url: "https://www.zhihu.com/question/77001", title: "如何保持不同镜头里的角色一致？" });
  assert.deepEqual(result.posts[1].parent, { kind: "column", url: "https://zhuanlan.zhihu.com/ai-film", title: "AI影视制作" });
  assert.equal(result.posts[1].text, "把每个镜头的输入和检查点列清楚。");
  assert.equal(result.posts[1].url, "https://zhuanlan.zhihu.com/p/88001");
  assert.equal(result.posts[0].metrics.views, null); assert.equal(result.posts[0].metrics.likes, 218);
  assert.equal(result.posts[0].comments[0].text, "参考图需要几个角度？");
  assert.equal(result.posts[0].commentCoverage.complete, false); assert.equal(result.posts[1].commentCoverage.complete, true);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.nextPage, 2);
  assert.ok(!JSON.stringify(result).includes("private-"));
  transport.assertNoPendingInterceptors();
});

test("知乎明确零评论的作品仍可完整入库，不因不存在的评论接口导致整页失败", async () => {
  zhihuFixture(transport, { answersComplete: true, zeroComments: true });
  const result = await collectMediaCreator({ platform: "zhihu", locator: "film-creator", cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login" });
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.posts.map(post => post.comments), [[], []]);
  assert.ok(result.posts.every(post => post.commentCoverage.complete));
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.nextPage, null);
  transport.assertNoPendingInterceptors();
});

test("知乎缺少必要会话或平台要求重新登录时返回等待登录，不泄露平台响应或会话", async () => {
  await assert.rejects(collectMediaCreator({ platform: "zhihu", locator: "film-creator" }),
    error => error instanceof MediaCrawlerFailure && error.code === "login_required" && !error.message.includes("private-"));
  transport.get("https://www.zhihu.com").intercept({ path: "/people/film-creator" }).reply(403, "private-platform-login-page");
  await assert.rejects(collectMediaCreator({ platform: "zhihu", locator: "film-creator", cookie: "d_c0=private-expired-device" }),
    error => error instanceof MediaCrawlerFailure && error.code === "login_required" && !error.message.includes("private-"));
  transport.assertNoPendingInterceptors();
});
