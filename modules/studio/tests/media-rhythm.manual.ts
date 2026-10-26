// Explicit native evidence verification: installed fixed PyAV, no model/platform/API call.
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { createLocalAsr } from "../backend/local-asr.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

after(async () => { await stopBoss(); await closeDb(); });
test("本地字幕取帧通路测量真实音量静区，不将字幕时间间隙当成静音，也不运行语音模型", { timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "../../.."), manager = createStorageWorkspaces();
  const workspace = await manager.reserve({ task: "native-rhythm-signal", category: "media", bytes: 520 * 1024 ** 2 });
  try {
    const python = path.join(root, "runtime/asr-env/Scripts/python.exe");
    const { stdout } = await promisify(execFile)(python, ["-I", "-B", path.join(import.meta.dirname, "rhythm-fixture.py")], { encoding: "buffer", maxBuffer: 2 * 1024 ** 2, windowsHide: true, timeout: 30000 });
    await manager.write(workspace.id, "source.media", (async function* () { yield stdout; })());
    const adapter = createLocalAsr({ python, modelDirectory: path.join(workspace.directory, "no-model-needed"), cwd: root });
    const input = { file: path.join(workspace.directory, "source.media"), signal: AbortSignal.timeout(90000) };
    const result = await adapter.frames(input), rhythm = result.rhythm;
    assert.ok(rhythm, "实际媒体结果必须携带节奏观察");
    assert.ok(rhythm.audio); assert.equal(rhythm.version, 1); assert.equal(rhythm.audio.method, "rms_20ms_v1");
    assert.equal(rhythm.audio.observedSeconds, 8); assert.equal(rhythm.audio.quietThresholdDbfs, -40);
    assert.equal(rhythm.audio.quietSeconds, 5);
    assert.deepEqual(rhythm.audio.quietIntervals, [{ start: 1, end: 2 }, { start: 3, end: 6 }, { start: 7, end: 8 }]);
    assert.equal(rhythm.audio.quietIntervalCount, 3); assert.equal(rhythm.audio.truncated, false);
    assert.ok(rhythm.visual, "实际视频必须交付有覆盖说明的画面变化观察");
    assert.equal(rhythm.visual.method, "sampled_rgb_v1"); assert.equal(rhythm.visual.sampleIntervalSeconds, 0.5);
    assert.equal(rhythm.visual.sampleCount, 16); assert.equal(rhythm.visual.sampledUntilSeconds, 7.5);
    assert.equal(rhythm.visual.changeCount, 3); assert.deepEqual(rhythm.visual.changeTimes, [2, 4, 6]);
    assert.equal(rhythm.visual.truncated, false);
    assert.equal(result.frames.length, 4);
    const recovered = createLocalAsr({ python: path.join(workspace.directory, "unavailable-python.exe"), modelDirectory: "unavailable-model", cwd: root });
    assert.deepEqual(await recovered.frames(input), result, "重试复用包含节奏的完整检查点");
  } finally { await manager.cleanup(workspace.id); }
});

test("合法的八秒视频只有六秒配音时，ASR仍保存完整画面时长和无声尾卡观察并立即清理媒体", { timeout: 180000 }, async () => {
  const resources = await sourceResourceFixture(), { app, headers } = resources;
  const previous = getGlobalDispatcher(), transport = new MockAgent();
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    await resources.warm();
    const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
      payload: { url: "https://space.bilibili.com/20813884" } })).json().creator.id;
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    bilibiliFixture(transport, { description: "真实配音提前结束，尾卡画面继续。" }); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
    await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    const root = path.resolve(import.meta.dirname, "../../.."), python = path.join(root, "runtime/asr-env/Scripts/python.exe");
    const { stdout } = await promisify(execFile)(python, ["-I", "-B", path.join(import.meta.dirname, "rhythm-fixture.py"), path.join(root, ".local/asr-quality/chinese.wav")],
      { encoding: "buffer", maxBuffer: 2 * 1024 ** 2, windowsHide: true, timeout: 30000 });
    transport.get("https://media.example").intercept({ path: "/voice-tail.mkv" }).reply(200, stdout);
    const local = createLocalAsr({ python, modelDirectory: path.join(root, "runtime/asr-model-large-v3-turbo-int8"), cwd: root });
    const result = await createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/voice-tail.mkv", kind: "video" }), recognize: local.recognize }).process(post.id);
    assert.equal(result.mediaCleaned, true);
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
    assert.equal(detail.transcript.durationSeconds, 8); assert.equal(detail.transcript.rhythm.audio.observedSeconds, 6);
    assert.equal(detail.transcript.rhythm.visual.sampledUntilSeconds, 7.5); assert.equal(detail.transcript.rhythm.visual.sampleCount, 16);
    assert.ok(detail.transcript.text.includes("视频")); assert.equal(detail.transcript.frames.at(-1).timeSeconds, 6);
    assert.equal(detail.transcript.mediaState, "cleaned"); assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
    transport.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await transport.close(); await app.close(); }
});

test("平台字幕不触发ASR，真实节奏与关键帧在删视频前可靠保存，并随私有情报和冻结材料读取", { timeout: 120000 }, async t => {
  const resources = await sourceResourceFixture(), { app, headers } = resources;
  const previous = getGlobalDispatcher(), transport = new MockAgent();
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  try {
    await resources.warm();
    const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
      payload: { url: "https://space.bilibili.com/20813884" } })).json().creator.id;
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    bilibiliFixture(transport); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
    await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
    const root = path.resolve(import.meta.dirname, "../../.."), python = path.join(root, "runtime/asr-env/Scripts/python.exe");
    const { stdout } = await promisify(execFile)(python, ["-I", "-B", path.join(import.meta.dirname, "rhythm-fixture.py")], { encoding: "buffer", maxBuffer: 2 * 1024 ** 2, windowsHide: true, timeout: 30000 });
    transport.get("https://media.example").intercept({ path: "/native-rhythm.mkv" }).reply(200, stdout, { headers: { "content-type": "video/x-matroska" } });
    const local = createLocalAsr({ python, modelDirectory: "unavailable-model", cwd: root });
    const processor = createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/native-rhythm.mkv", kind: "video",
      subtitles: { language: "zh-CN", durationSeconds: 8, model: "platform-fixture", segments: [{ start: 0, end: 8, text: "整段字幕跨越静音区，不用字幕间隙代替真实测量。" }] } }),
      recognize: async () => { throw new Error("可靠平台字幕不调用语音模型"); }, frames: local.frames });
    assert.equal((await processor.process(post.id)).mediaCleaned, true);
    assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}` })).statusCode, 401);
    const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
    assert.ok(detail.transcript.rhythm, "字幕通路不能丢弃实际测量的节奏证据");
    assert.equal(detail.transcript.rhythm.audio.quietSeconds, 5); assert.equal(detail.transcript.rhythm.visual.changeCount, 3);
    assert.equal(detail.transcript.mediaState, "cleaned"); assert.equal(detail.transcript.method, "platform_subtitle");
    assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0);
    const startsAt = new Date(Date.parse(post.collectedAt) - 3600_000).toISOString();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, enabled: false, startsAt } })).statusCode, 200);
    t.mock.timers.enable({ apis: ["Date"], now: new Date(Date.parse(startsAt) + 48 * 3600_000 + 1000) }); await resources.warm();
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } }); assert.equal(frozen.statusCode, 200);
    const materials = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers })).json().rows;
    assert.deepEqual(materials.find((item: { id: string }) => item.id === `creator:${post.id}`).transcript.rhythm, detail.transcript.rhythm);
    transport.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await transport.close(); await app.close(); }
});
