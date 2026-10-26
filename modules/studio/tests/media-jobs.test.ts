import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { weiboFixture, weiboVideoDetailFixture, bilibiliFixture, xhsVideoDetailFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { installModules } from "@aihot/backend/modules";
import { workModuleQueues } from "@aihot/backend/jobs/queue";
import { setTimeout as delay } from "node:timers/promises";
import { gate } from "../../../tests/setup.ts";
import { xhsFixture } from "./mediacrawler-fixture.ts";
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("开启媒体处理后，新采集视频自动持久排队；重复提交不叠任务，处理结果可读且临时媒体即时归还空间", async () => {
  process.env.STUDIO_MEDIA_ENABLED = "true"; await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } });
  assert.equal(added.statusCode, 200); const creatorId = added.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  weiboFixture(transport, { complete: true, video: true });
  const boss = await getBoss(), [collected] = await boss.fetch(creatorQueue.name); assert.ok(collected);
  await creatorQueue.run([collected.data] as never[]); await boss.complete(creatorQueue.name, collected.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const endpoint = `/api/admin/studio/media-processing/${post.id}`;
  const queued = await app.inject({ url: endpoint, headers }); assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().state, "queued"); assert.equal(queued.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  const duplicate = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().queued, false);
  const { createMediaProcessingQueue } = await import("../backend/media-jobs.ts");
  const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#51635a" } }).png().toBuffer();
  const queue = createMediaProcessingQueue({ recognize: async () => ({ language: "zh", durationSeconds: 6, model: "external-asr-fixture",
    segments: [{ start: 0, end: 6, text: "自动排队保留完整步骤，处理结束即清视频。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] }) });
  const [job] = await boss.fetch<{ postId: string; fingerprint: string }>(queue.name); assert.ok(job); assert.equal(job.data.postId, post.id); assert.match(job.data.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await boss.fetch(queue.name)).length, 0);
  weiboVideoDetailFixture(transport);
  transport.get("https://f.video.weibocdn.com").intercept({ path: "/fixture-video.mp4" }).reply(200, Buffer.from("external-weibo-queue-video"));
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const finished = (await app.inject({ url: endpoint, headers })).json(); assert.equal(finished.state, "ready");
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.equal(detail.transcript.text, "自动排队保留完整步骤，处理结束即清视频。"); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
  transport.assertNoPendingInterceptors();
});

test("实际媒体消费者在低磁盘时保持原任务零重试，恢复后处理；转写期间博主采集仍排队，结束后自动继续", { timeout: 30_000 }, async () => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers,
    payload: { version: 0, cookie: "a1=private-queue-fixture; web_session=private-queue-session" } })).statusCode, 200);
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id, boss = await getBoss();
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} });
  xhsFixture(transport, { complete: true, video: true });
  const [collected] = await boss.fetch(creatorQueue.name); assert.ok(collected); await creatorQueue.run([collected.data] as never[]); await boss.complete(creatorQueue.name, collected.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const { createMediaProcessingQueue } = await import("../backend/media-jobs.ts");
  const entered = gate(), release = gate(), png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#476158" } }).png().toBuffer();
  const queue = createMediaProcessingQueue({ recognize: async () => { entered.open(); await release.promise;
    return { language: "zh", durationSeconds: 6, model: "external-asr-fixture", segments: [{ start: 0, end: 6, text: "资源恢复后继续同一个任务。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
  } }, resources.host, resources.disk, resources.database);
  const collecting = { ...creatorQueue, admission: resources.admission };
  installModules([{ ...studio, name: "media-worker-acceptance", queues: [queue, collecting] }]);
  const [pending] = await boss.findJobs(queue.name, { queued: true }); assert.ok(pending);
  resources.capacity.diskBytes = 5_000_000_000; await resources.warm();
  const stop = await workModuleQueues(boss);
  try {
    await resources.warm(); await delay(2200);
    const [waiting] = await boss.findJobs(queue.name, { id: pending.id }); assert.equal(waiting!.state, "created"); assert.equal(waiting!.retryCount, 0);
    assert.equal((await app.inject({ url: `/api/admin/studio/media-processing/${post.id}`, headers })).json().state, "queued");
    xhsVideoDetailFixture(transport);
    transport.get("https://sns-video-bd.xhscdn.com").intercept({ path: "/fixture-origin.mp4" }).reply(200, Buffer.from("external-queue-video"));
    resources.capacity.diskBytes = 6_000_000_000; await resources.warm();
    await Promise.race([entered.promise, delay(6000).then(() => { throw new Error("media worker did not resume"); })]);
    assert.equal((await app.inject({ url: `/api/admin/studio/media-processing/${post.id}`, headers })).json().state, "running");
    const weibo = (await app.inject({ url: "/api/admin/studio/creators?platform=weibo", headers })).json().rows[0];
    let platformReads = 0; weiboFixture(transport, { complete: true, video: true, onRead: () => { platformReads++; } });
    await app.inject({ method: "POST", url: `/api/admin/studio/creators/${weibo.id}/collect`, headers, payload: {} });
    await delay(2200); assert.equal(platformReads, 0, "ASR占用期间不能同时启动浏览器/博主采集");
    const [waitingCreator] = await boss.findJobs(collecting.name, { queued: true }); assert.ok(waitingCreator); assert.equal(waitingCreator.retryCount, 0);
    release.open();
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && ((await boss.findJobs(queue.name, { id: pending.id }))[0]?.state !== "completed" || Number(platformReads) !== 1)) await delay(50);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "completed");
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.retryCount, 0); assert.equal(platformReads, 1);
  } finally { release.open(); await stop(); }
  assert.equal((await app.inject({ url: `/api/admin/studio/media-processing/${post.id}`, headers })).json().state, "ready");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});

test("两日选题冻结等待本批已排队视频处理，终止的任务保留明确正文缺口而不永久卡住批次", async t => {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } }); assert.equal(added.statusCode, 200);
  const creatorId = added.json().creator.id, boss = await getBoss();
  await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} });
  bilibiliFixture(transport);
  const [collected] = await boss.fetch(creatorQueue.name); assert.ok(collected); await creatorQueue.run([collected.data] as never[]); await boss.complete(creatorQueue.name, collected.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const startsAt = new Date(Date.parse(post.collectedAt) - 3600_000).toISOString();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.parse(startsAt) + 48 * 3600_000 + 1000) });
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, enabled: false, startsAt } })).statusCode, 200);
  const blocked = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } });
  assert.equal(blocked.statusCode, 503); assert.match(blocked.json().detail, /视频|转写/);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
  const { mediaProcessingQueue } = await import("../backend/media-jobs.ts");
  const [pending] = await boss.findJobs(mediaProcessingQueue.name, { queued: true }); assert.ok(pending);
  await boss.cancel(mediaProcessingQueue.name, pending.id);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } });
  assert.equal(frozen.statusCode, 200);
  const materials = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers })).json().rows;
  assert.equal(materials.find((row: { id: string }) => row.id === `creator:${post.id}`).bodyState, "not_transcribed");
  transport.assertNoPendingInterceptors();
});
