// Explicit offline PyAV verification; synthetic fixture only, no platform or model API.
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { closeDb } from "@aihot/backend/db";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";
import { createLocalAsr } from "../backend/local-asr.ts";

after(closeDb);
test("只有取帧时无需ASR模型或音轨识别，真实PyAV在小资源组内保存四帧，并可在没有Python时恢复检查点", async () => {
  const root = path.resolve(import.meta.dirname, "../../.."), manager = createStorageWorkspaces();
  const workspace = await manager.reserve({ task: "manual-local-frames-only", category: "media", bytes: 16 * 1024 ** 2 });
  try {
    await manager.write(workspace.id, "source.media", (async function* () { yield await readFile(path.join(root, ".local/asr-quality/chinese-video.mp4")); })());
    const adapter = createLocalAsr({ python: path.join(root, "runtime/asr-env/Scripts/python.exe"), modelDirectory: path.join(workspace.directory, "unavailable-model"), cwd: root });
    const input = { file: path.join(workspace.directory, "source.media"), signal: AbortSignal.timeout(30000) };
    const result = await adapter.frames(input); assert.equal(result.frames.length, 4); assert.ok(result.durationSeconds > 24 && result.durationSeconds < 26);
    const colors = [];
    for (const frame of result.frames) {
      const body = Buffer.from(frame.pngBase64, "base64"), info = await sharp(body).metadata();
      assert.equal(info.format, "png"); assert.equal(info.width, 320); assert.equal(info.height, 180);
      colors.push((await sharp(body).stats()).channels[0]!.mean);
    }
    assert.ok(new Set(colors).size >= 3);
    const restarted = createLocalAsr({ python: path.join(workspace.directory, "unavailable-python.exe"), modelDirectory: path.join(workspace.directory, "unavailable-model"), cwd: root });
    assert.deepEqual(await restarted.frames(input), result);
    console.info(JSON.stringify({ manualFramesOnly: true, syntheticFixture: true, frames: result.frames.map(frame => frame.timeSeconds), durationSeconds: result.durationSeconds }));
  } finally { await manager.cleanup(workspace.id); }
});
