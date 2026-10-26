import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { douyinFixture, douyinVideoDetailFixture, douyinCookie } from "./douyin-fixture.ts";
import { kuaishouFixture, kuaishouVideoDetailFixture, kuaishouCookie } from "./kuaishou-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createPlatformMediaProcessor } from "../backend/platform-media.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { collectMediaCreator, MediaCrawlerFailure } from "../backend/mediacrawler.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("抖音下载前通过原签名客户端刷新指定作品，同源Cookie风控参数保持一致，不重扫博主列表", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/douyin", headers, payload: { version: 0, cookie: douyinCookie } })).statusCode, 200);
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.douyin.com/user/MS4wLjABAAAAfilm_fixture" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  douyinFixture(transport, { complete: true, media: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows.find((row: { kind: string }) => row.kind === "video");
  douyinVideoDetailFixture(transport, { url: "https://v3-dy-o.zjcdn.com/refreshed-video.mp4" });
  transport.get("https://v3-dy-o.zjcdn.com").intercept({ path: "/refreshed-video.mp4" }).reply(200, "refreshed-douyin-complete");
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#38635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    assert.equal(await readFile(input.file, "utf8"), "refreshed-douyin-complete");
    return { language: "zh", durationSeconds: 6, model: "refresh-asr-fixture", segments: [{ start: 0, end: 6, text: "从同一作品取得新的完整视频地址。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "从同一作品取得新的完整视频地址。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("抖音和快手指定刷新拒绝其他作品、其他作者及不可用视频，非法作品ID不触发网络", async () => {
  const douyin = { platform: "douyin", locator: "MS4wLjABAAAAfilm_fixture", videoId: "7600000000000000001", cookie: douyinCookie };
  for (const mismatch of [{ owner: "MS4wLjABAAAAanother" }, { id: "7600000000000000099" }]) {
    douyinVideoDetailFixture(transport, mismatch);
    await assert.rejects(collectMediaCreator(douyin), error => error instanceof MediaCrawlerFailure && error.code === "platform_failed");
  }
  const kuaishou = { platform: "kuaishou", locator: "3xfilmfixture", videoId: "3xfilmvideo", cookie: kuaishouCookie };
  for (const mismatch of [{ owner: "3xanother" }, { id: "3xanotherVideo" }, { unavailable: true }]) {
    kuaishouVideoDetailFixture(transport, mismatch);
    await assert.rejects(collectMediaCreator(kuaishou), error => error instanceof MediaCrawlerFailure && error.code === "platform_failed");
  }
  await assert.rejects(collectMediaCreator({ ...douyin, videoId: "../another-video" }), /指定视频媒体标识或平台无效/);
  await assert.rejects(collectMediaCreator({ ...kuaishou, videoId: "../another-video" }), /指定视频媒体标识或平台无效/);
  transport.assertNoPendingInterceptors();
});

test("快手通过原visionVideoDetail刷新当前作品媒体，受控GraphQL不能改作主页或写操作", async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/kuaishou", headers, payload: { version: 0, cookie: kuaishouCookie } })).statusCode, 200);
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.kuaishou.com/profile/3xfilmfixture" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  kuaishouFixture(transport, { complete: true, media: true });
  const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  kuaishouVideoDetailFixture(transport, { url: "https://v.kwaicdn.com/refreshed-video.mp4" });
  transport.get("https://v.kwaicdn.com").intercept({ path: "/refreshed-video.mp4" }).reply(200, "refreshed-kuaishou-complete");
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#42635a" } }).png().toBuffer();
  await createPlatformMediaProcessor({ recognize: async input => {
    assert.equal(await readFile(input.file, "utf8"), "refreshed-kuaishou-complete");
    return { language: "zh", durationSeconds: 6, model: "refresh-asr-fixture", segments: [{ start: 0, end: 6, text: "只刷新已关注作者的当前作品。" }],
      frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "只刷新已关注作者的当前作品。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});
