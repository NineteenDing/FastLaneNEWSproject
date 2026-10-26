import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { bilibiliFixture, weiboFixture, xhsFixture, zhihuFixture } from "./mediacrawler-fixture.ts";
import { tiebaFixture } from "./tieba-fixture.ts";
import { douyinFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouFixture, kuaishouCookie } from "./kuaishou-fixture.ts";

installModules(SERVER_MODULES);
const app = await buildApp(), previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
let sessionHeaders: { cookie: string; "x-csrf-token": string } | undefined;
async function auth() {
  if (sessionHeaders) return sessionHeaders;
  config.adminPassword = "creator-collection-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=creator-collection-test-password" });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } }); assert.equal(me.statusCode, 200);
  sessionHeaders = { cookie, "x-csrf-token": me.json().csrf }; return sessionHeaders;
}
test("博主手动采集提交持久任务，真实MediaCrawler资料内容入私有库，重采更新热度而不重复材料", async () => {
  const headers = await auth();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  const id = added.json().creator.id;
  const queued = await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().queued, true);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  assert.ok(queue);
  const boss = await getBoss();
  const run = async () => {
    const [job] = await boss.fetch<{ creatorId: string }>(queue.name);
    assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  };
  bilibiliFixture(transport); await run();
  const read = async () => (await app.inject({ url: `/api/admin/studio/creators?q=20813884`, headers })).json().rows[0];
  const account = await read();
  assert.equal(account.name, "影视流程研究"); assert.equal(account.workCount, 1); assert.equal(account.collectedCount, 1);
  assert.equal(account.collectionState, "ready"); assert.ok(account.lastCheckedAt);
  assert.deepEqual(account.collectionCoverage, { page: 1, nextPage: null, complete: true });
  const first = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
  assert.equal(first.statusCode, 200); assert.equal(first.json().total, 1);
  const post = first.json().rows[0];
  assert.equal(post.title, "角色一致性的方法"); assert.equal(post.transcript, null);
  assert.equal(post.comments[0].text, "换镜头后怎么维持角色？");
  assert.equal(post.commentCoverage.complete, false);
  bilibiliFixture(transport, { views: 18000 });
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).json().queued, true);
  await run();
  const second = (await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers })).json();
  assert.equal(second.total, 1); assert.equal(second.rows[0].id, post.id);
  assert.equal(second.rows[0].metrics.views, 18000);
  assert.deepEqual(second.rows[0].observations.map((o: { metrics: { views: number } }) => o.metrics.views), [12000, 18000]);
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/contents` })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});

test("平台登录失效显示需要登录，保留先前正文与热度，不冒充没有新内容或更新成功时间", async () => {
  const headers = await auth();
  const before = (await app.inject({ url: "/api/admin/studio/creators?q=20813884", headers })).json().rows[0];
  const queued = await app.inject({ method: "POST", url: `/api/admin/studio/creators/${before.id}/collect`, headers, payload: {} });
  assert.equal(queued.statusCode, 200);
  transport.get("https://api.bilibili.com").intercept({ path: "/x/web-interface/nav" }).reply(200, { code: -101, message: "登录信息已失效 private-upstream-message" });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  await assert.rejects(queue.run([job!.data] as never[]), /采集未完成/);
  await boss.fail(queue.name, job!.id, { message: "platform failure" });
  const current = (await app.inject({ url: "/api/admin/studio/creators?q=20813884", headers })).json().rows[0];
  assert.equal(current.collectionState, "login_required");
  assert.equal(current.lastCheckedAt, before.lastCheckedAt);
  assert.equal(current.collectedCount, 1);
  assert.equal(current.name, "影视流程研究");
  assert.ok(!JSON.stringify(current).includes("private-upstream-message"));
  const saved = (await app.inject({ url: `/api/admin/studio/creators/${before.id}/contents`, headers })).json();
  assert.equal(saved.rows[0].metrics.views, 18000);
  transport.assertNoPendingInterceptors();
});

test("采集开关、暂停、移除与未登记账号不能绕过；已排队后暂停也不读取平台", async () => {
  const headers = await auth();
  const added = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/434377496" } })).json().creator;
  const send = () => app.inject({ method: "POST", url: `/api/admin/studio/creators/${added.id}/collect`, headers, payload: {} });
  process.env.COLLECT_ENABLED = "false";
  assert.equal((await send()).statusCode, 409);
  process.env.COLLECT_ENABLED = "true";
  assert.equal((await send()).statusCode, 200);
  const paused = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${added.id}/status`, headers, payload: { version: added.version, enabled: false } });
  assert.equal(paused.statusCode, 200);
  assert.equal((await send()).statusCode, 409);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const card = (await app.inject({ url: "/api/admin/studio/creators?q=434377496", headers })).json().rows[0];
  assert.equal(card.lastCheckedAt, null); assert.equal(card.collectedCount, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/creators/00000000-0000-0000-0000-000000000000/collect", headers, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${added.id}/collect`, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  transport.assertNoPendingInterceptors();
});

test("平台请求期间暂停关注，迟到的采集结果不能覆盖已有材料和成功时间", async () => {
  const headers = await auth();
  const before = (await app.inject({ url: "/api/admin/studio/creators?q=20813884", headers })).json().rows[0];
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${before.id}/collect`, headers, payload: {} });
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  bilibiliFixture(transport, { views: 25000, onRead: reached });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  const running = queue.run([job!.data] as never[]);
  await reading;
  const paused = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${before.id}/status`, headers, payload: { version: before.version, enabled: false } });
  assert.equal(paused.statusCode, 200);
  await running; await boss.complete(queue.name, job!.id);
  const after = (await app.inject({ url: "/api/admin/studio/creators?q=20813884", headers })).json().rows[0];
  assert.equal(after.collectionState, "interrupted"); assert.equal(after.lastCheckedAt, before.lastCheckedAt);
  const saved = (await app.inject({ url: `/api/admin/studio/creators/${before.id}/contents`, headers })).json();
  assert.equal(saved.rows[0].metrics.views, 18000);
  transport.assertNoPendingInterceptors();
});

test("微博与小红书复用持久队列入库，各自Cookie只到本平台，重启式续采使用已保存游标且卡片不泄露游标", async () => {
  const headers = await auth();
  const cookies = { weibo: "SUB=private-weibo-cookie", xhs: "a1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; web_session=private-xhs-session" };
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss();
  for (const platform of ["weibo", "xhs"] as const) {
    const save = await app.inject({ method: "PUT", url: `/api/admin/studio/platform-sessions/${platform}`, headers, payload: { version: 0, cookie: cookies[platform] } });
    assert.equal(save.statusCode, 200);
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
      payload: { url: platform === "weibo" ? "https://weibo.com/u/5756404150" : "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae?xsec_token=private-profile-token&xsec_source=pc_share" } });
    assert.equal(created.statusCode, 200);
    const id = created.json().creator.id;
    for (const complete of [false, true]) {
      const queued = await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} });
      assert.equal(queued.statusCode, 200, platform);
      if (platform === "weibo") weiboFixture(transport, { expectedCookie: cookies.weibo, expectedCursor: complete ? "5300000000000010" : "", complete });
      else xhsFixture(transport, { expectedCookie: cookies.xhs, expectedCursor: complete ? "next-notes-page" : "", complete });
      const [job] = await boss.fetch(queue.name); assert.ok(job);
      await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
      const listing = await app.inject({ url: `/api/admin/studio/creators?platform=${platform}`, headers });
      const account = listing.json().rows[0];
      assert.equal(account.collectionState, "ready"); assert.equal(account.collectedCount, 1);
      assert.equal(account.collectionCoverage.complete, complete);
      assert.ok(!listing.body.includes("private-")); assert.ok(!listing.body.includes("next-notes-page")); assert.ok(!listing.body.includes("5300000000000010"));
      const content = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
      assert.equal(content.json().total, 1);
      assert.equal(content.json().rows[0].kind, platform === "weibo" ? "post" : "image_text");
      assert.ok(content.json().rows[0].metrics.likes > 0);
      assert.ok(!content.body.includes("private-"));
    }
  }
  transport.assertNoPendingInterceptors();
});

test("小红书没有会话时明确等待登录，保存新会话后自动重新排队而不等待原失败退避", async () => {
  const headers = await auth();
  const before = (await app.inject({ url: "/api/admin/studio/creators?platform=xhs", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers, payload: { version: 1, cookie: "" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${before.id}/collect`, headers, payload: {} })).statusCode, 200);
  const studio = SERVER_MODULES.find(m => m.name === "studio")!, queue = studio.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  await assert.rejects(queue.run([job!.data] as never[]), /采集未完成/); await boss.fail(queue.name, job!.id, { message: "login required" });
  const failed = (await app.inject({ url: "/api/admin/studio/creators?platform=xhs", headers })).json().rows[0];
  assert.equal(failed.collectionState, "login_required"); assert.equal(failed.lastCheckedAt, before.lastCheckedAt);
  const schedule = studio.schedules!.find(s => s.name === "studio.creator.schedule")!;
  assert.equal((await schedule.run() as { queued: number }).queued, 0, "等待登录时不能反复空跑");
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers,
    payload: { version: 2, cookie: "a1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; web_session=private-renewed-session" } })).statusCode, 200);
  assert.equal((await schedule.run() as { queued: number }).queued, 1, "新会话应恢复待登录采集");
  const pending = await boss.findJobs<{ creatorId: string }>(queue.name, { queued: true });
  assert.equal(pending[0]!.data.creatorId, before.id);
  await boss.cancel(queue.name, pending[0]!.id);
  transport.assertNoPendingInterceptors();
});

test("采集进行中更换会话，旧会话返回的结果不会覆盖当前资料或添加指标观察", async () => {
  const headers = await auth();
  const before = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0];
  const contentsBefore = (await app.inject({ url: `/api/admin/studio/creators/${before.id}/contents`, headers })).json();
  const session = (await app.inject({ url: "/api/admin/studio/platform-sessions", headers })).json().rows.find((p: { platform: string }) => p.platform === "weibo");
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  weiboFixture(transport, { expectedCookie: "SUB=private-weibo-cookie", complete: true, onRead: reached });
  const queued = await app.inject({ method: "POST", url: `/api/admin/studio/creators/${before.id}/collect`, headers, payload: {} }); assert.equal(queued.statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  const running = queue.run([job!.data] as never[]); await reading;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers, payload: { version: session.version, cookie: "SUB=private-renewed-cookie" } })).statusCode, 200);
  await running; await boss.complete(queue.name, job!.id);
  const after = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0];
  assert.equal(after.collectionState, "interrupted"); assert.equal(after.lastCheckedAt, before.lastCheckedAt);
  const contentsAfter = (await app.inject({ url: `/api/admin/studio/creators/${before.id}/contents`, headers })).json();
  assert.equal(contentsAfter.rows[0].observations.length, contentsBefore.rows[0].observations.length);
  transport.assertNoPendingInterceptors();
});

test("更换会话后旧请求才报登录失效，旧错误不得挡住新会话自动续采", async () => {
  const headers = await auth();
  const unrelated = (await app.inject({ url: "/api/admin/studio/creators?platform=xhs", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${unrelated.id}/status`, headers,
    payload: { version: unrelated.version, enabled: false } })).statusCode, 200);
  const before = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0];
  const session = (await app.inject({ url: "/api/admin/studio/platform-sessions", headers })).json().rows.find((p: { platform: string }) => p.platform === "weibo");
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  transport.get("https://m.weibo.cn").intercept({ path: (value: string) => value.startsWith("/api/container/getIndex?") })
    .reply(() => { reached(); return { statusCode: 401, data: {} }; }).delay(300);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${before.id}/collect`, headers, payload: {} })).statusCode, 200);
  const studio = SERVER_MODULES.find(m => m.name === "studio")!, queue = studio.queues!.find(q => q.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  const running = queue.run([job!.data] as never[]).then(() => null, error => error);
  await reading;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers,
    payload: { version: session.version, cookie: "SUB=private-new-login" } })).statusCode, 200);
  await running; await boss.complete(queue.name, job!.id);
  const after = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0];
  assert.equal(after.collectionState, "interrupted"); assert.equal(after.lastCheckedAt, before.lastCheckedAt);
  assert.equal((await studio.schedules!.find(s => s.name === "studio.creator.schedule")!.run() as { queued: number }).queued, 1);
  const pending = await boss.findJobs<{ creatorId: string }>(queue.name, { queued: true });
  assert.equal(pending[0]!.data.creatorId, before.id); await boss.cancel(queue.name, pending[0]!.id);
  transport.assertNoPendingInterceptors();
});

test("知乎回答文章分别续采：已完成的文章流不重抓，相同数字ID分别保存，重复回答只增加观察", async () => {
  const headers = await auth();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.zhihu.com/people/film-creator" } });
  assert.equal(added.statusCode, 200); const id = added.json().creator.id;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/zhihu", headers,
    payload: { version: 0, cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login" } })).statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  for (const secondPage of [false, true]) {
    zhihuFixture(transport, { answerOffset: secondPage ? 15 : 0, answersComplete: secondPage, articlesFinished: secondPage });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const listing = await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers });
    const account = listing.json().rows[0];
    assert.equal(account.collectionState, "ready"); assert.equal(account.collectionSupported, true);
    assert.equal(account.collectedCount, 2); assert.equal(account.collectionCoverage.complete, secondPage);
    assert.ok(!listing.body.includes("private-")); assert.ok(!listing.body.includes('"answers"'));
  }
  const contents = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
  assert.equal(contents.statusCode, 200); assert.equal(contents.headers["cache-control"], "no-store");
  const rows = contents.json().rows;
  assert.equal(rows.find((post: { kind: string }) => post.kind === "answer").observations.length, 2);
  assert.equal(rows.find((post: { kind: string }) => post.kind === "article").observations.length, 1);
  assert.equal(rows.find((post: { kind: string }) => post.kind === "answer").parent.kind, "question");
  assert.equal(rows.find((post: { kind: string }) => post.kind === "article").parent.kind, "column");
  assert.ok(!contents.body.includes("private-"));
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/contents` })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});

test("贴吧主页采集复用持久队列，续页保留帖子身份、楼层和热度，私有结果不回显会话", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://tieba.baidu.com/home/main?id=tb.fixture" } });
  assert.equal(created.statusCode, 200); const id = created.json().creator.id;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/tieba", headers,
    payload: { version: 0, cookie: "BDUSS=private-tieba-cookie" } })).statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  let previousId: string | undefined;
  for (const page of [1, 2]) {
    tiebaFixture(transport, { page, complete: page === 2 });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const listing = await app.inject({ url: "/api/admin/studio/creators?platform=tieba", headers });
    const account = listing.json().rows[0];
    assert.equal(account.collectionSupported, true); assert.equal(account.collectionState, "ready");
    assert.equal(account.name, "漫剧镜头研究"); assert.equal(account.collectedCount, 1);
    assert.equal(account.collectionCoverage.complete, page === 2);
    const contents = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
    assert.equal(contents.headers["cache-control"], "no-store"); assert.equal(contents.json().total, 1);
    const post = contents.json().rows[0];
    assert.equal(post.comments[0].floor, 2); assert.equal(post.observations.length, page);
    if (previousId) assert.equal(post.id, previousId); previousId = post.id;
    assert.ok(!listing.body.includes("private-")); assert.ok(!contents.body.includes("private-"));
  }
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/contents` })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});

test("抖音主页任务持久续采，视频图文独立保存且重采仅增加热度观察", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.douyin.com/user/MS4wLjABAAAAfilm_fixture" } });
  assert.equal(created.statusCode, 200); const id = created.json().creator.id;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/douyin", headers,
    payload: { version: 0, cookie: douyinCookie } })).statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const identities = new Set<string>();
  for (const secondPage of [false, true]) {
    douyinFixture(transport, { cursor: secondPage ? "1792200000000" : "", complete: secondPage });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const listing = await app.inject({ url: "/api/admin/studio/creators?platform=douyin", headers });
    const account = listing.json().rows[0];
    assert.equal(account.name, "AI镜头实验"); assert.equal(account.collectionState, "ready"); assert.equal(account.collectedCount, 2);
    assert.equal(account.collectionCoverage.complete, secondPage);
    const contents = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
    assert.equal(contents.headers["cache-control"], "no-store"); assert.equal(contents.json().total, 2);
    for (const post of contents.json().rows) {
      assert.equal(post.transcript, null); assert.equal(post.observations.length, secondPage ? 2 : 1);
      if (secondPage) assert.ok(identities.has(post.id)); identities.add(post.id);
    }
    assert.ok(!listing.body.includes("private-")); assert.ok(!listing.body.includes("1792200000000")); assert.ok(!contents.body.includes("private-"));
  }
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/contents` })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});

test("快手新REST作品经持久队列续页，原作品身份不变且私有页面可以读取评论和指标观察", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.kuaishou.com/profile/3xfilmfixture" } });
  assert.equal(created.statusCode, 200); const id = created.json().creator.id;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/kuaishou", headers,
    payload: { version: 0, cookie: kuaishouCookie } })).statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  let identity: string | undefined;
  for (const secondPage of [false, true]) {
    kuaishouFixture(transport, { cursor: secondPage ? "next-private-cursor" : "", complete: secondPage });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const listing = await app.inject({ url: "/api/admin/studio/creators?platform=kuaishou", headers });
    const account = listing.json().rows[0];
    assert.equal(account.name, "漫剧制作记录"); assert.equal(account.collectionState, "ready"); assert.equal(account.collectedCount, 1);
    assert.equal(account.collectionCoverage.complete, secondPage);
    const contents = await app.inject({ url: `/api/admin/studio/creators/${id}/contents`, headers });
    assert.equal(contents.headers["cache-control"], "no-store"); assert.equal(contents.json().total, 1);
    const post = contents.json().rows[0];
    assert.equal(post.comments[0].text, "长镜头怎么保证角色一致？"); assert.equal(post.observations.length, secondPage ? 2 : 1);
    if (secondPage) assert.equal(post.id, identity); identity = post.id;
    assert.ok(!listing.body.includes("private-")); assert.ok(!contents.body.includes("private-"));
  }
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/contents` })).statusCode, 401);
  transport.assertNoPendingInterceptors();
});
