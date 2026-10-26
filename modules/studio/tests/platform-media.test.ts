import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { access } from "node:fs/promises";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { xhsFixture, xhsVideoDetailFixture, weiboFixture, weiboVideoDetailFixture, bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { douyinFixture, douyinVideoDetailFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouFixture, kuaishouVideoDetailFixture, kuaishouCookie } from "./kuaishou-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("小红书视频采集后可直接复用原MediaCrawler媒体地址，无需手填下载链接，转写和帧保存后清媒体", async () => {
  await resources.warm();
  const session = await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers,
    payload: { version: 0, cookie: "a1=private-media-fixture; web_session=private-media-session" } }); assert.equal(session.statusCode, 200);
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  xhsFixture(transport, { complete: true, video: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0]; assert.equal(post.kind, "video");
  assert.equal(post.media, undefined, "临时下载地址仅供后台处理，不进入作品阅读数据");
  xhsVideoDetailFixture(transport);
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  transport.get("https://sns-video-bd.xhscdn.com").intercept({ path: "/fixture-origin.mp4", headers: { referer: "https://www.xiaohongshu.com/" } }).reply(200, Buffer.from("external-xhs-video-bytes"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#28635a" } }).png().toBuffer(); let mediaFile = "";
  await createPlatformMediaProcessor({ recognize: async input => {
    mediaFile = input.file; return { language: "zh", durationSeconds: 8, model: "external-asr-fixture", segments: [{ start: 0, end: 8, text: "先固定角色图，再对照两个镜头检查人物。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers }); assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().transcript.text, "先固定角色图，再对照两个镜头检查人物。"); assert.equal(detail.json().transcript.visualEvidence, "keyframes_saved");
  assert.equal(detail.json().transcript.mediaState, "cleaned"); await assert.rejects(access(mediaFile), { code: "ENOENT" });
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("微博附视频帖子正确识别为视频并复用原媒体提取器，不能只把配文当成完整正文供选题", async () => {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  weiboFixture(transport, { complete: true, video: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0]; assert.equal(post.kind, "video"); assert.equal(post.media, undefined);
  const endpoint = `/api/admin/studio/intelligence/creator:${post.id}`;
  assert.equal((await app.inject({ url: endpoint, headers })).json().bodyState, "not_transcribed");
  weiboVideoDetailFixture(transport);
  transport.get("https://f.video.weibocdn.com").intercept({ path: "/fixture-video.mp4", headers: { referer: "https://m.weibo.cn/" } }).reply(200, Buffer.from("external-weibo-video"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#3a635a" } }).png().toBuffer();
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  await createPlatformMediaProcessor({ recognize: async () => ({ language: "zh", durationSeconds: 6, model: "external-asr-fixture",
    segments: [{ start: 0, end: 6, text: "这段视频演示分镜与画面的衔接顺序。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }) }).process(post.id);
  const detail = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(detail.bodyState, "transcribed"); assert.equal(detail.transcript.text, "这段视频演示分镜与画面的衔接顺序。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("抖音复用已受控采集的原视频媒体提取，图文作品不被误送音轨识别，完整结果仍立即清理", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/douyin", headers, payload: { version: 0, cookie: douyinCookie } })).statusCode, 200);
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.douyin.com/user/MS4wLjABAAAAfilm_fixture" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  douyinFixture(transport, { complete: true, media: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const posts = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows;
  const post = posts.find((item: { kind: string }) => item.kind === "video"), images = posts.find((item: { kind: string }) => item.kind === "image_text"); assert.ok(post); assert.ok(images);
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  douyinVideoDetailFixture(transport);
  transport.get("https://v3-dy-o.zjcdn.com").intercept({ path: "/fixture-video.mp4", headers: { referer: "https://www.douyin.com/" } }).reply(200, Buffer.from("external-douyin-video"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#40635a" } }).png().toBuffer(); let calls = 0;
  const processor = createPlatformMediaProcessor({ recognize: async () => { calls++; return { language: "zh", durationSeconds: 6, model: "external-asr-fixture",
    segments: [{ start: 0, end: 6, text: "先用角色参考锁定人物，再调整两个镜头。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }; } });
  await assert.rejects(processor.process(images.id), /没有可转写的视频/); assert.equal(calls, 0);
  await processor.process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "先用角色参考锁定人物，再调整两个镜头。"); assert.equal(detail.transcript.mediaState, "cleaned"); assert.equal(calls, 1);
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("快手在原photo结构中复用媒体提取器，保持真实签名采集入口并接同一可靠转写清理流程", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/kuaishou", headers, payload: { version: 0, cookie: kuaishouCookie } })).statusCode, 200);
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.kuaishou.com/profile/3xfilmfixture" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  kuaishouFixture(transport, { complete: true, media: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0]; assert.equal(post.kind, "video"); assert.equal(post.media, undefined);
  kuaishouVideoDetailFixture(transport);
  transport.get("https://v.kwaicdn.com").intercept({ path: "/fixture-video.mp4", headers: { referer: "https://www.kuaishou.com/" } }).reply(200, Buffer.from("external-kuaishou-video"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#45635a" } }).png().toBuffer();
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  await createPlatformMediaProcessor({ recognize: async () => ({ language: "zh", durationSeconds: 6, model: "external-asr-fixture",
    segments: [{ start: 0, end: 6, text: "用近景与远景对照角色造型。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }) }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "用近景与远景对照角色造型。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("B站下载时通过固定原客户端重新解析该作品的单段完整MP4，不把分离音轨或最大分片冒充完整视频", async () => {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const api = transport.get("https://api.bilibili.com");
  api.intercept({ path: value => new URL(value, "https://api.bilibili.com").pathname === "/x/web-interface/view/detail" && new URL(value, "https://api.bilibili.com").searchParams.get("bvid") === "BV1fixture" })
    .reply(200, { code: 0, data: { View: { aid: 12345, bvid: "BV1fixture", cid: 666, title: "角色一致性的方法", desc: "先锁定参考，再组织镜头", owner: { mid: 20813884, name: "影视流程研究" }, pages: [{ cid: 666 }], stat: { view: 12000 } } } });
  api.intercept({ path: "/x/web-interface/nav" }).reply(200, { code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  api.intercept({ path: value => { const url = new URL(value, "https://api.bilibili.com"); return url.pathname === "/x/player/wbi/playurl" && url.searchParams.get("fnval") === "1" && url.searchParams.get("cid") === "666" && !!url.searchParams.get("w_rid"); } })
    .reply(200, { code: 0, data: { durl: [{ url: "https://upos-sz.example.bilivideo.com/fixture-video.mp4", size: 1000 }] } });
  api.intercept({ path: /^\/x\/player\/wbi\/v2\?/ }).reply(200, { code: 0, data: { subtitle: { subtitles: [] } } });
  transport.get("https://upos-sz.example.bilivideo.com").intercept({ path: "/fixture-video.mp4", headers: { referer: "https://www.bilibili.com/" } }).reply(200, Buffer.from("external-bilibili-complete-mp4"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#52635a" } }).png().toBuffer();
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  await createPlatformMediaProcessor({ recognize: async () => ({ language: "zh", durationSeconds: 6, model: "external-asr-fixture",
    segments: [{ start: 0, end: 6, text: "B站分镜演示需要完整音轨与画面证据。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }) }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "B站分镜演示需要完整音轨与画面证据。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("B站完整中文平台字幕优先于其他语言和ASR，受控读取全量字幕后仅取画面，正文与时间段保持原样", async () => {
  await resources.warm();
  const creatorId = (await app.inject({ url: "/api/admin/studio/creators?platform=bilibili", headers })).json().rows[0].id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport, { description: "这条作品现在可取得完整平台字幕" });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job); await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0], api = transport.get("https://api.bilibili.com");
  api.intercept({ path: /^\/x\/web-interface\/view\/detail\?/ }).reply(200, { code: 0, data: { View: { aid: 12345, bvid: "BV1fixture", duration: 8, title: "角色一致性的方法", owner: { mid: 20813884 }, pages: [{ cid: 666 }] } } });
  api.intercept({ path: "/x/web-interface/nav" }).reply(200, { code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  api.intercept({ path: /^\/x\/player\/wbi\/playurl\?/ }).reply(200, { code: 0, data: { durl: [{ url: "https://upos-sz.example.bilivideo.com/subtitle-video.mp4", size: 1000 }] } });
  api.intercept({ path: value => { const url = new URL(value, "https://api.bilibili.com"); return url.pathname === "/x/player/wbi/v2" && url.searchParams.get("cid") === "666"; } })
    .reply(200, { code: 0, data: { subtitle: { subtitles: [{ lan: "en", subtitle_url: "https://aisubtitle.hdslb.com/unused-english.json" }, { lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/fixture.json" }] } } });
  transport.get("https://aisubtitle.hdslb.com").intercept({ path: "/bfs/subtitle/fixture.json" }).reply(200, { body: [
    { from: 0, to: 4, content: "先保留角色参考，再组织镜头。" }, { from: 4, to: 8, content: "平台字幕保留原始步骤与适用条件。" },
  ] });
  transport.get("https://upos-sz.example.bilivideo.com").intercept({ path: "/subtitle-video.mp4" }).reply(200, Buffer.from("external-video-only-needed-for-frames"));
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#60635a" } }).png().toBuffer();
  const { createPlatformMediaProcessor } = await import("../backend/platform-media.ts");
  await createPlatformMediaProcessor({ recognize: async () => { throw new Error("ASR must not run for a complete platform subtitle"); },
    frames: async () => ({ durationSeconds: 8, frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }),
  }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.method, "platform_subtitle"); assert.equal(detail.transcript.language, "zh-CN");
  assert.equal(detail.transcript.text, "先保留角色参考，再组织镜头。\n平台字幕保留原始步骤与适用条件。");
  assert.equal(detail.transcript.segments[1].start, 4); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});
