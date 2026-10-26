import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import type { MediaRhythm } from "../contracts.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("超过实际媒体时长的节奏证据不能入库或导致视频被清理，修正后复用原下载并可靠保存", async () => {
  await resources.warm();
  const creatorId = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://space.bilibili.com/20813884" } })).json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  const valid: MediaRhythm = { version: 1, audio: { method: "rms_20ms_v1", timeBasis: "decoded_audio", observedSeconds: 8, quietThresholdDbfs: -40, minimumQuietSeconds: 0.3,
    quietSeconds: 5, quietIntervalCount: 3, quietIntervals: [{ start: 1, end: 2 }, { start: 3, end: 6 }, { start: 7, end: 8 }], truncated: false,
    windows: [{ start: 0, end: 8, rmsDbfs: -20, quietFraction: 0.625 }] }, visual: null };
  const invalid = structuredClone(valid); invalid.audio!.quietIntervals[2]!.end = 9;
  transport.get("https://media.example").intercept({ path: "/rhythm-evidence.wav" }).reply(200, "complete-audio-boundary-fixture");
  let file = "";
  const recognize = async (rhythm: MediaRhythm) => ({ language: "zh", durationSeconds: 8, model: "external-rhythm-fixture",
    segments: [{ start: 0, end: 8, text: "静区需要从实际音频测量，不凭字幕断句推算。" }], rhythm });
  await assert.rejects(createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/rhythm-evidence.wav", kind: "audio" }),
    recognize: async input => { file = input.file; return recognize(invalid); } }).process(post.id), /节奏/);
  assert.equal(await readFile(file, "utf8"), "complete-audio-boundary-fixture");
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json().bodyState, "not_transcribed");
  assert.ok((await createStorageWorkspaces().status()).reservedBytes > 0);
  await createMediaTranscriptionProcessor({ resolve: async () => { throw new Error("完整下载检查点无需重新下载"); }, recognize: async () => recognize(valid) }).process(post.id);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/creator:${post.id}`, headers })).json();
  assert.deepEqual(detail.transcript.rhythm, valid); assert.equal(detail.transcript.mediaState, "cleaned");
  assert.equal((await createStorageWorkspaces().status()).reservedBytes, 0); transport.assertNoPendingInterceptors();
});
