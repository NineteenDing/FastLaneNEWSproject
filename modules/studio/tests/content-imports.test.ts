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
import { bilibiliFixture, weiboVideoDetailFixture, xhsVideoDetailFixture } from "./mediacrawler-fixture.ts";
import { douyinVideoDetailFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouVideoDetailFixture, kuaishouCookie } from "./kuaishou-fixture.ts";

installModules(SERVER_MODULES);
const app = await buildApp(), previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
let headers: { cookie: string; "x-csrf-token": string };

test("单条作品接入情报库不自动关注作者，重复链接复用，明确关注后沿用原内容身份", async () => {
  const path = "/api/admin/studio/content-imports";
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  config.adminPassword = "content-import-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=content-import-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  headers = { cookie, "x-csrf-token": me.json().csrf };
  const added = await app.inject({ method: "POST", url: path, headers, payload: { url: "https://www.bilibili.com/video/BV1fixture?share_source=copy" } });
  assert.equal(added.statusCode, 200); assert.equal(added.json().queued, true);
  const id = added.json().item.id;
  const api = transport.get("https://api.bilibili.com");
  api.intercept({ path: /^\/x\/web-interface\/view\/detail\?/ }).reply(200, { code: 0, data: { View: {
    aid: 12345, bvid: "BV1fixture", title: "角色一致性的方法", desc: "先固定参考，再组织两个镜头。", owner: { mid: 20813884, name: "影视流程研究" },
    pages: [{ cid: 666 }], stat: { view: 12000, reply: 80 }, pubdate: 1792231200,
  } } });
  api.intercept({ path: "/x/web-interface/nav" }).reply(200, { code: 0, data: { wbi_img: {
    img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
  } } });
  api.intercept({ path: /^\/x\/player\/wbi\/playurl\?/ }).reply(200, { code: 0, data: { durl: [{ url: "https://upos-sz.example.bilivideo.com/fixture-video.mp4", size: 1000 }] } });
  api.intercept({ path: /^\/x\/player\/wbi\/v2\?/ }).reply(200, { code: 0, data: { subtitle: { subtitles: [] } } });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.content.import")!;
  assert.ok(queue); const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const list = await app.inject({ url: path, headers }); assert.equal(list.statusCode, 200);
  const item = list.json().rows.find((row: { id: string }) => row.id === id);
  assert.equal(item.state, "ready"); assert.match(item.materialId, /^creator:/);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${item.materialId}`, headers })).json();
  assert.equal(detail.title, "角色一致性的方法"); assert.equal(detail.bodyState, "not_transcribed");
  assert.equal(detail.body, "先固定参考，再组织两个镜头。"); assert.equal(detail.metrics.views, 12000);
  const duplicate = await app.inject({ method: "POST", url: path, headers, payload: { url: "https://www.bilibili.com/video/BV1fixture/" } });
  assert.equal(duplicate.json().item.id, id); assert.equal(duplicate.json().queued, false);
  const followed = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(followed.statusCode, 200); assert.equal(followed.json().creator.collectedCount, 1);
  assert.equal(followed.json().creator.enabled, true);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 1);
  const contents = (await app.inject({ url: `/api/admin/studio/creators/${followed.json().creator.id}/contents`, headers })).json();
  assert.equal("creator:" + contents.rows[0].id, item.materialId);
  transport.assertNoPendingInterceptors();
});

test("微博小红书抖音快手指定作品复用原SDK，私有会话与分享参数不回显，仍只关注用户明确添加的账号", async () => {
  const samples = [
    { platform: "weibo", cookie: "SUB=private-single-weibo", url: "https://m.weibo.cn/detail/5300000000000011", fixture: () => weiboVideoDetailFixture(transport), title: "新功能让分镜更容易衔接 & 修改。" },
    { platform: "xhs", cookie: "a1=private-single-xhs; web_session=private-session", url: "https://www.xiaohongshu.com/explore/670000000000000001234567?xsec_token=private-note-token&xsec_source=pc_feed", fixture: () => xhsVideoDetailFixture(transport), title: "多镜头角色一致性" },
    { platform: "douyin", cookie: douyinCookie, url: "https://www.douyin.com/video/7600000000000000001", fixture: () => douyinVideoDetailFixture(transport), title: "先固定角色，再做不同镜头。" },
    { platform: "kuaishou", cookie: kuaishouCookie, url: "https://www.kuaishou.com/short-video/3xfilmvideo", fixture: () => kuaishouVideoDetailFixture(transport), title: "固定角色，再安排近景与远景。" },
  ];
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.content.import")!, boss = await getBoss();
  for (const sample of samples) {
    assert.equal((await app.inject({ method: "PUT", url: `/api/admin/studio/platform-sessions/${sample.platform}`, headers, payload: { version: 0, cookie: sample.cookie } })).statusCode, 200);
    const added = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: sample.url } });
    assert.equal(added.statusCode, 200, sample.platform); assert.equal(added.json().queued, true);
    sample.fixture(); const [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const list = await app.inject({ url: "/api/admin/studio/content-imports", headers });
    assert.ok(!list.body.includes("private-"));
    const item = list.json().rows.find((row: { id: string }) => row.id === added.json().item.id);
    assert.equal(item.state, "ready");
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${item.materialId}`, headers })).json();
    assert.equal(detail.title, sample.title); assert.equal(detail.source.platform, sample.platform);
    assert.equal(detail.bodyState, "not_transcribed"); assert.equal(detail.commentCoverage.complete, false);
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 1);
  transport.assertNoPendingInterceptors();
});

test("导入任务中断显示可恢复状态，只有显式重试才新建任务，旧任务与无授权请求不能写入", async () => {
  const path = "/api/admin/studio/content-imports", url = "https://www.bilibili.com/video/BV1retryfixture";
  for (const value of ["https://127.0.0.1/video/BV1fixture", "https://bilibili.com.evil.invalid/video/BV1fixture", "https://user:pass@www.bilibili.com/video/BV1fixture", "https://www.bilibili.com:444/video/BV1fixture"]) {
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { url: value } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie: headers.cookie }, payload: { url } })).statusCode, 403);
  process.env.COLLECT_ENABLED = "false";
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { url } })).statusCode, 409);
  process.env.COLLECT_ENABLED = "true";
  const submitted = await app.inject({ method: "POST", url: path, headers, payload: { url } }); assert.equal(submitted.statusCode, 200);
  const id = submitted.json().item.id, boss = await getBoss();
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.content.import")!;
  const [old] = await boss.fetch(queue.name); assert.ok(old); await boss.fail(queue.name, old.id);
  const failed = (await app.inject({ url: path, headers })).json().rows.find((row: { id: string }) => row.id === id);
  assert.equal(failed.state, "failed"); assert.equal(failed.errorCode, "job_interrupted");
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { url } })).json().queued, false);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { url, retryFailed: true } })).json().queued, true);
  await queue.run([old.data] as never[]);
  const current = (await app.inject({ url: path, headers })).json().rows.find((row: { id: string }) => row.id === id);
  assert.equal(current.state, "queued"); assert.equal(current.materialId, null);
  transport.assertNoPendingInterceptors();
});

test("已关注博主收录的作品直接作为补充参考复用，不再读平台或用缺评论的单作品结果覆盖旧材料", async () => {
  const creator = (await app.inject({ url: "/api/admin/studio/creators?platform=bilibili", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport, { bvid: "BV1knownfixture" });
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const before = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows.find((row: { externalId: string }) => row.externalId === "BV1knownfixture");
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: "https://www.bilibili.com/video/BV1knownfixture" } });
  assert.equal(added.statusCode, 200); assert.equal(added.json().queued, false); assert.equal(added.json().item.state, "ready");
  assert.equal(added.json().item.materialId, "creator:" + before.id);
  const after = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows.find((row: { id: string }) => row.id === before.id);
  assert.deepEqual(after, before); assert.equal(after.comments[0].text, "换镜头后怎么维持角色？");
  transport.assertNoPendingInterceptors();
});
