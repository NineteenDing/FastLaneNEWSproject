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
import { xhsFixture, xhsVideoDetailFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createPlatformMediaProcessor } from "../backend/platform-media.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("原片地址失效后按原采集器清晰度顺序使用完整候选，可靠保存转写后立即清理", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers,
    payload: { version: 0, cookie: "a1=candidate-fixture; web_session=candidate-session" } })).statusCode, 200);
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  // Listed out of quality order; the real fixed upstream extractor chooses 1080p before 720p.
  xhsFixture(transport, { complete: true, video: true, videoStreams: [
    { master_url: "https://sns-video-bd.xhscdn.com/low.mp4", height: 720 },
    { master_url: "https://sns-video-bd.xhscdn.com/complete.mp4", height: 1080 },
  ] });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  xhsVideoDetailFixture(transport, { videoStreams: [
    { master_url: "https://sns-video-bd.xhscdn.com/low.mp4", height: 720 },
    { master_url: "https://sns-video-bd.xhscdn.com/complete.mp4", height: 1080 },
  ] });
  const seen: string[] = [], cdn = transport.get("https://sns-video-bd.xhscdn.com");
  cdn.intercept({ path: "/fixture-origin.mp4" }).reply(() => { seen.push("origin"); return { statusCode: 403, data: "expired" }; });
  cdn.intercept({ path: "/complete.mp4", headers: { referer: "https://www.xiaohongshu.com/" } })
    .reply(() => { seen.push("1080p"); return { statusCode: 200, data: "complete-video", responseOptions: { headers: { "content-type": "video/mp4" } } }; });
  let file = "";
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#38635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    file = input.file; assert.equal(await readFile(file, "utf8"), "complete-video");
    return { language: "zh", durationSeconds: 6, model: "candidate-asr-fixture", segments: [{ start: 0, end: 6, text: "先锁定角色，再检查两个镜头的一致性。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  assert.deepEqual(seen, ["origin", "1080p"]);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "先锁定角色，再检查两个镜头的一致性。"); assert.equal(detail.transcript.mediaState, "cleaned");
  await assert.rejects(access(file), { code: "ENOENT" });
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

async function updatedVideo(text: string, backups: string[], refreshes = 1) {
  await resources.warm();
  const creatorId = (await app.inject({ url: "/api/admin/studio/creators?platform=xhs", headers })).json().rows[0].id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  xhsFixture(transport, { complete: true, video: true, text, videoStreams: backups.map((master_url, index) => ({ master_url, height: 1080 - index * 360 })) });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  xhsVideoDetailFixture(transport, { videoStreams: backups.map((master_url, index) => ({ master_url, height: 1080 - index * 360 })), calls: refreshes });
  return (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
}

test("HTTP200的HTML错误页不能送去识别或保存为完整媒体，有备用地址时继续获取真媒体", async () => {
  const post = await updatedVideo("需要检查视频源的实际内容类型。", ["https://sns-video-bd.xhscdn.com/real-media.mp4"]);
  const cdn = transport.get("https://sns-video-bd.xhscdn.com");
  cdn.intercept({ path: "/fixture-origin.mp4" }).reply(200, "<html>访问验证</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  cdn.intercept({ path: "/real-media.mp4" }).reply(200, "actual-complete-media", { headers: { "content-type": "Application/MP4; charset=binary" } });
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#41635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    assert.equal(await readFile(input.file, "utf8"), "actual-complete-media");
    return { language: "zh", durationSeconds: 6, model: "candidate-asr-fixture", segments: [{ start: 0, end: 6, text: "错误页不能当成视频的识别依据。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "错误页不能当成视频的识别依据。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("全部候选失效时不识别或冒充已转写，也不让空下载目录占用后续视频空间", async () => {
  const post = await updatedVideo("全部候选已失效，需等待原作品恢复。", ["https://sns-video-bd.xhscdn.com/gone-one.mp4", "https://sns-video-bd.xhscdn.com/gone-two.mp4"]);
  const cdn = transport.get("https://sns-video-bd.xhscdn.com");
  cdn.intercept({ path: "/fixture-origin.mp4" }).reply(403, "expired");
  cdn.intercept({ path: "/gone-one.mp4" }).reply(404, "not found");
  cdn.intercept({ path: "/gone-two.mp4" }).reply(410, "gone");
  let recognized = false;
  await assert.rejects(createPlatformMediaProcessor({ recognize: async () => { recognized = true; throw new Error("不得识别失败下载"); } }).process(post.id), /视频下载未完成/);
  assert.equal(recognized, false);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0, "没有可重用媒体的空目录应释放预留");
  transport.assertNoPendingInterceptors();
});

test("不把206片段拼接或当成全片，备用地址返回完整200媒体后才能识别", async () => {
  const post = await updatedVideo("当前源返回分片，需完整备用视频。", ["https://sns-video-bd.xhscdn.com/full-after-partial.mp4"]);
  const cdn = transport.get("https://sns-video-bd.xhscdn.com");
  cdn.intercept({ path: "/fixture-origin.mp4" }).reply(206, "partial", { headers: { "content-type": "video/mp4", "content-range": "bytes 0-6/100" } });
  cdn.intercept({ path: "/full-after-partial.mp4" }).reply(200, "whole-video", { headers: { "content-type": "application/octet-stream" } });
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#48635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    assert.equal(await readFile(input.file, "utf8"), "whole-video", "没有将partial拼到全片前面");
    return { language: "zh", durationSeconds: 6, model: "candidate-asr-fixture", segments: [{ start: 0, end: 6, text: "完整视频才能提供完整转写依据。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "完整视频才能提供完整转写依据。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("限流或上游故障交回持久任务重试，不逐个候选放大请求，也不占用空目录额度", async () => {
  const post = await updatedVideo("暂时限流，留给持久任务退避。", ["https://sns-video-bd.xhscdn.com/must-not-fetch.mp4"], 2);
  let recognized = false;
  const processor = createPlatformMediaProcessor({ recognize: async () => { recognized = true; throw new Error("不得识别限流响应"); } });
  for (const status of [429, 503]) {
    transport.get("https://sns-video-bd.xhscdn.com").intercept({ path: "/fixture-origin.mp4" }).reply(status, "retry later");
    // No backup interceptor is registered: any extra request would fail the expected error.
    await assert.rejects(processor.process(post.id), /视频下载未完成/);
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  }
  assert.equal(recognized, false);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  transport.assertNoPendingInterceptors();
});

test("下载期间取消后不访问后续候选、不启动识别，空预留被释放", async () => {
  const post = await updatedVideo("当前媒体处理已取消。", ["https://sns-video-bd.xhscdn.com/must-not-fetch-after-abort.mp4"]);
  const controller = new AbortController(); let recognized = false;
  transport.get("https://sns-video-bd.xhscdn.com").intercept({ path: "/fixture-origin.mp4" }).reply(() => {
    // Cancel a live delayed request, after Undici has finished initializing it.
    setImmediate(() => controller.abort()); return { statusCode: 403, data: "expired" };
  }).delay(200);
  await assert.rejects(createPlatformMediaProcessor({ recognize: async () => { recognized = true; throw new Error("不得识别已取消任务"); } })
    .process(post.id, { signal: controller.signal }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(recognized, false);
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  transport.assertNoPendingInterceptors();
});

test("音视频族HLS类型和误标二进制的播放清单都必须跳过，继续完整MP4候选而不建立错误检查点", async () => {
  const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://media.example/segment.ts\n";
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#50635a" } }).png().toBuffer();
  for (const contentType of ["audio/x-mpegurl", "audio/mpegurl", "video/vnd.mpegurl", "application/octet-stream"]) {
    const post = await updatedVideo(`拒绝播放清单类型${contentType}。`, ["https://sns-video-bd.xhscdn.com/after-playlist.mp4"]);
    const cdn = transport.get("https://sns-video-bd.xhscdn.com");
    cdn.intercept({ path: "/fixture-origin.mp4" }).reply(200, playlist, { headers: { "content-type": contentType } });
    cdn.intercept({ path: "/after-playlist.mp4" }).reply(200, "complete-after-playlist", { headers: { "content-type": "video/mp4" } });
    await createPlatformMediaProcessor({ recognize: async input => {
      assert.equal(await readFile(input.file, "utf8"), "complete-after-playlist", `${contentType}清单未被当作已完成媒体`);
      return { language: "zh", durationSeconds: 6, model: "candidate-asr-fixture", segments: [{ start: 0, end: 6, text: "只识别完整本地视频，不把播放清单当素材。" }],
        frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
    } }).process(post.id);
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
    assert.equal(detail.transcript.text, "只识别完整本地视频，不把播放清单当素材。"); assert.equal(detail.transcript.mediaState, "cleaned");
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
  }
});
