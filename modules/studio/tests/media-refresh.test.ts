import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { access, readFile } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { weiboFixture, weiboVideoDetailFixture, xhsFixture, xhsVideoDetailFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createPlatformMediaProcessor } from "../backend/platform-media.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("微博排队视频在下载前重取指定作品地址，不重扫主页或把新配文改写到已收录材料", async () => {
  await resources.warm();
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://weibo.com/u/5756404150" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  weiboFixture(transport, { complete: true, video: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  weiboVideoDetailFixture(transport, { text: "<p>刷新时平台配文已经改变。</p>", url: "https://f.video.weibocdn.com/fresh-video.mp4" });
  transport.get("https://f.video.weibocdn.com").intercept({ path: "/fresh-video.mp4", headers: { referer: "https://m.weibo.cn/" } }).reply(200, "fresh-complete-video");
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#38635a" } }).png().toBuffer(); let file = "";
  const processor = createPlatformMediaProcessor({ recognize: async input => {
    file = input.file; assert.equal(await readFile(file, "utf8"), "fresh-complete-video");
    return { language: "zh", durationSeconds: 6, model: "refresh-asr-fixture", segments: [{ start: 0, end: 6, text: "先锁定角色，再检查两个镜头的一致性。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } });
  await processor.process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "先锁定角色，再检查两个镜头的一致性。"); assert.equal(detail.transcript.mediaState, "cleaned");
  const current = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  assert.equal(current.text, post.text); assert.equal(current.title, post.title); assert.equal(current.media, undefined);
  await assert.rejects(access(file), { code: "ENOENT" });
  // Once persisted, reopening processing does not contact the platform again.
  await processor.process(post.id);
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("小红书指定笔记刷新在原客户端返回错作者或错笔记时明确失败，缺少作品token不能借用主页身份读取", async () => {
  const input = { platform: "xhs", locator: "5eb8e1d400000000010075ae", videoId: "670000000000000001234567",
    cookie: "a1=refresh-fixture; web_session=refresh-session", context: { xsec_token: "private-note-token", xsec_source: "pc_feed" } };
  for (const mismatch of [{ owner: "5eb8e1d40000000001000000" }, { note: "670000000000000009999999" }]) {
    xhsVideoDetailFixture(transport, mismatch);
    await assert.rejects(collectMediaCreator(input), error => error instanceof MediaCrawlerFailure && error.code === "platform_failed");
  }
  await assert.rejects(collectMediaCreator({ ...input, context: {} }), /指定视频媒体标识或平台无效/);
  await assert.rejects(collectMediaCreator({ ...input, videoId: "../another-note" }), /指定视频媒体标识或平台无效/);
  transport.assertNoPendingInterceptors();
});

test("小红书使用采集时的作品访问参数单独刷新媒体，不复用主页token且不把访问参数泄露到阅读内容", async t => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers,
    payload: { version: 0, cookie: "a1=refresh-fixture; web_session=refresh-session" } })).statusCode, 200);
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae?xsec_token=private-profile-token&xsec_source=pc_share" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  xhsFixture(transport, { complete: true, video: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const contents = await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers }), post = contents.json().rows[0];
  assert.ok(!contents.body.includes("private-note-token")); assert.ok(!contents.body.includes("private-profile-token"));
  const api = transport.get("https://edith.xiaohongshu.com");
  api.intercept({ path: "/api/sns/web/v1/feed", method: "POST", body: value => {
    const body = JSON.parse(Buffer.from(value).toString("utf8")); return body.source_note_id === "670000000000000001234567" && body.xsec_token === "private-note-token" && body.xsec_source === "pc_feed";
  } }).reply(200, { success: true, code: 0, data: { items: [{ note_card: {
    note_id: "670000000000000001234567", type: "video", title: "多镜头角色一致性", desc: "先固定角色参考，再制作不同景别。",
    user: { user_id: "5eb8e1d400000000010075ae" }, video: { consumer: { origin_video_key: "fresh-xhs.mp4" } },
  } }] } });
  transport.get("https://sns-video-bd.xhscdn.com").intercept({ path: "/fresh-xhs.mp4" }).reply(200, "fresh-xhs-complete-video");
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#49635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    assert.equal(await readFile(input.file, "utf8"), "fresh-xhs-complete-video");
    return { language: "zh", durationSeconds: 6, model: "refresh-asr-fixture", segments: [{ start: 0, end: 6, text: "笔记访问参数只用于后台重新解析视频。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers });
  assert.equal(detail.json().transcript.text, "笔记访问参数只用于后台重新解析视频。"); assert.equal(detail.json().transcript.mediaState, "cleaned");
  assert.ok(!detail.body.includes("private-note-token")); assert.ok(!detail.body.includes("private-profile-token"));
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: false, startsAt: window.startsAt } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(window.endsAt) });
  await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: window.startsAt } });
  assert.equal(frozen.statusCode, 200);
  const materials = await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers });
  assert.ok(materials.json().rows.some((item: { id: string }) => item.id === `creator:${post.id}`));
  assert.ok(!materials.body.includes("private-note-token")); assert.ok(!materials.body.includes("private-profile-token"));
});

test("指定作品刷新拒绝错作者、错作品、删除与登录失效，不降级下载旧地址或留下空间预留", async () => {
  const creatorId = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0].id;
  const attempts = ["wrong-owner", "wrong-post", "deleted", "login"] as const;
  for (const attempt of attempts) {
    await resources.warm();
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    weiboFixture(transport, { complete: true, video: true, text: `当前采集说明：${attempt}` });
    const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
    await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    if (attempt === "wrong-owner") weiboVideoDetailFixture(transport, { owner: "999999" });
    else if (attempt === "wrong-post") weiboVideoDetailFixture(transport, { id: "999999" });
    else transport.get("https://m.weibo.cn").intercept({ path: "/detail/5300000000000011" })
      .reply(attempt === "deleted" ? 200 : 403, attempt === "deleted" ? "<html>作品已删除</html>" : "需要登录");
    let recognized = false;
    await assert.rejects(createPlatformMediaProcessor({ recognize: async () => { recognized = true; throw new Error("不能识别未验证作品"); } }).process(post.id),
      /平台读取未完成/);
    assert.equal(recognized, false);
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
    assert.equal(detail.bodyState, "not_transcribed"); assert.equal(detail.transcript, null);
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
    transport.assertNoPendingInterceptors();
  }
});
