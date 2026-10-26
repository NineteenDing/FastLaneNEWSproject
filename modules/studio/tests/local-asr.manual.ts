// Explicit local verification only: requires the fixed downloaded model and the locally synthesized Chinese fixture.
// Not part of automatic/offline CI *.test.ts; no platform or model API is used.
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { closeDb } from "@aihot/backend/db";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { createLocalAsr } from "../backend/local-asr.ts";
import sharp from "sharp";

after(closeDb);
test("固定本地多语模型在Windows资源组中以CPU INT8双线程识别中文，已完成结果重试只复用一个检查点", { timeout: 600000 }, async () => {
  const root = path.resolve(import.meta.dirname, "../../.."), manager = createStorageWorkspaces();
  const workspace = await manager.reserve({ task: "manual-native-asr-quality", category: "media", bytes: 520 * 1024 ** 2 });
  try {
    const source = await readFile(path.join(root, ".local/asr-quality/chinese.wav"));
    await manager.write(workspace.id, "source.media", (async function* () { yield source; })());
    const adapter = createLocalAsr({ python: path.join(root, "runtime/asr-env/Scripts/python.exe"), modelDirectory: path.join(root, "runtime/asr-model-large-v3-turbo-int8"), cwd: root });
    const input = { file: path.join(workspace.directory, "source.media"), signal: AbortSignal.timeout(300000) };
    const started = Date.now(), first = await adapter.recognize(input), text = first.segments.map(segment => segment.text).join("");
    assert.equal(first.language, "zh"); assert.ok(first.durationSeconds > 10 && first.durationSeconds < 60);
    for (const word of ["角色", "光", "流程"]) assert.ok(text.includes(word), `Missing expected Chinese topic word: ${word}`);
    assert.ok(first.segments.every(segment => segment.end > segment.start));
    assert.ok(first.rhythm?.audio); assert.equal(first.rhythm.audio.timeBasis, "decoded_audio");
    assert.equal(first.rhythm.visual, null, "只有音频时不虚构画面变化");
    const checkpoint = path.join(workspace.directory, "recognition.json"), original = await readFile(checkpoint);
    await rename(checkpoint, path.join(workspace.directory, "recognition.part"));
    const restarted = createLocalAsr({ python: path.join(workspace.directory, "unavailable-python.exe"), modelDirectory: path.join(workspace.directory, "unavailable-model"), cwd: root });
    const second = await restarted.recognize(input); assert.deepEqual(second, first);
    assert.deepEqual(await restarted.recognize(input), first);
    const files = await readdir(workspace.directory); assert.equal(files.filter(name => name.endsWith(".json")).length, 1); assert.ok(!files.includes("recognition.part"));
    await writeFile(input.file, "changed-media-must-not-use-old-recognition");
    await assert.rejects(restarted.recognize(input), /其他媒体或模型/); assert.deepEqual(await readFile(checkpoint), original);
    console.info(JSON.stringify({ manualChineseSample: true, syntheticAudio: true, durationSeconds: first.durationSeconds, elapsedMs: Date.now() - started, text }));
  } finally { await manager.cleanup(workspace.id); }
});

test("实际本地视频在同一个受控识别任务中同时交付中文分段和真实少量关键帧，不把音轨识别冒充画面观察", { timeout: 600000 }, async () => {
  const root = path.resolve(import.meta.dirname, "../../.."), manager = createStorageWorkspaces();
  const workspace = await manager.reserve({ task: "manual-native-video-evidence", category: "media", bytes: 520 * 1024 ** 2 });
  try {
    const source = await readFile(path.join(root, ".local/asr-quality/chinese-video.mp4"));
    await manager.write(workspace.id, "source.media", (async function* () { yield source; })());
    const adapter = createLocalAsr({ python: path.join(root, "runtime/asr-env/Scripts/python.exe"), modelDirectory: path.join(root, "runtime/asr-model-large-v3-turbo-int8"), cwd: root });
    const first = await adapter.recognize({ file: path.join(workspace.directory, "source.media"), signal: AbortSignal.timeout(300000) });
    assert.ok(first.segments.map(segment => segment.text).join("").includes("角色"));
    assert.equal(first.frames?.length, 4);
    assert.ok(first.rhythm?.audio); assert.ok(first.rhythm.visual); assert.equal(first.rhythm.visual.timeBasis, "video_elapsed");
    assert.ok(first.frames[0]!.timeSeconds < 1); assert.ok(first.frames[3]!.timeSeconds > 20);
    const colors = [];
    for (const frame of first.frames) {
      const body = Buffer.from(frame.pngBase64, "base64"), metadata = await sharp(body).metadata();
      assert.equal(metadata.format, "png"); assert.equal(metadata.width, 320); assert.equal(metadata.height, 180);
      colors.push((await sharp(body).stats()).channels[0]!.mean);
    }
    assert.ok(new Set(colors).size >= 3); assert.ok(first.frames.every(frame => frame.timeSeconds <= first.durationSeconds + 0.1));
    console.info(JSON.stringify({ manualVideoEvidence: true, syntheticFixture: true, durationSeconds: first.durationSeconds, frameTimes: first.frames.map(frame => frame.timeSeconds) }));
  } finally { await manager.cleanup(workspace.id); }
});
