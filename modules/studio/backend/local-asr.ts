import { lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Conflict } from "@aihot/backend/audit";
import { config } from "@aihot/backend/config";
import { runWindowsProcessGroup } from "./windows-process-group.ts";
import { parseMediaVisuals, type MediaRecognition, type MediaVisuals } from "./media-transcription.ts";
import {parseLocalAsrRecognition} from './local-asr-result.ts';
import { createStorageWorkspaces } from "./storage-workspaces.ts";

async function fileDigest(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function savedOutput(file: string, maximumBytes: number): Promise<Record<string, unknown> | null> {
  const entry = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximumBytes) throw new Conflict("本地转写检查点不安全或超过结果预算，未清理原媒体");
  try { const parsed = JSON.parse((await readFile(file, "utf8")).replace(/\0+$/, "")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
}

/** Internal speech-recognition Adapter. Input must belong to the caller's reserved temporary workspace. */
export function createLocalAsr(options: { python: string; modelDirectory: string; cwd: string }) {
  type Input = { file: string; signal: AbortSignal };
  async function invoke(input: Input, mode: "speech"): Promise<MediaRecognition>;
  async function invoke(input: Input, mode: "frames"): Promise<MediaVisuals>;
  async function invoke(input: Input, mode: "speech" | "frames") {
      input.signal.throwIfAborted();
      const original = await lstat(input.file), root = await realpath(path.join(config.dataDir, "studio/workspaces")), source = await realpath(input.file);
      const relative = path.relative(root, source).split(path.sep);
      if (original.isSymbolicLink() || !original.isFile() || relative.length !== 2 || !/^[a-f0-9-]{36}$/i.test(relative[0]!) || relative[1] !== "source.media")
        throw new Conflict("本地转写只接受本项目受管临时媒体");
      const manifest = mode === "speech" ? JSON.parse(await readFile(path.join(import.meta.dirname, "../vendor/faster-whisper/runtime.json"), "utf8")) as { model: { sha256: string; bytes: number } } : null;
      const signature = manifest?.model.sha256 ?? createHash("sha256").update("pyav19.0.1-keyframes-v1").digest("hex");
      const name = mode === "speech" ? "recognition" : "frames", maximumBytes = (mode === "speech" ? 8 : 6) * 1024 ** 2;
      const sourceSha256 = await fileDigest(source), output = path.join(path.dirname(source), `${name}.json`), partial = path.join(path.dirname(source), `${name}.part`);
      const decode = (saved: Record<string, unknown>) => {
        if (saved.sourceSha256 !== sourceSha256 || saved.modelSha256 !== signature) throw new Conflict("已有转写检查点属于其他媒体或模型，已保留，请核对后重新处理");
        return mode === "speech" ? parseLocalAsrRecognition(saved.recognition) : parseMediaVisuals(saved.visuals);
      };
      const completed = await savedOutput(output, maximumBytes);
      if (completed) return decode(completed);
      const interrupted = await savedOutput(partial, maximumBytes);
      if (interrupted?.[mode === "speech" ? "recognition" : "visuals"]) {
        const recovered = decode(interrupted); await rename(partial, output); return recovered;
      }
      if (interrupted) await unlink(partial); // Only an incomplete/failed result; complete recognition above is always preserved.
      if (manifest) {
        const model = path.join(path.resolve(options.modelDirectory), "model.bin"), modelEntry = await lstat(model);
        if (!modelEntry.isFile() || modelEntry.isSymbolicLink() || modelEntry.size !== manifest.model.bytes || await fileDigest(model) !== manifest.model.sha256)
          throw new Conflict("本地模型不完整或版本校验失败，未开始转写");
      }
      // Allocate the bounded result through the existing shared capacity/4.7GB write guard.
      // The native process only overwrites and shrinks this buffer; it cannot grow a fresh unaccounted result.
      await createStorageWorkspaces().write(relative[0]!, `${name}.part`, (async function* () { yield Buffer.alloc(maximumBytes); })());
      const result = await runWindowsProcessGroup({ executable: path.resolve(options.python),
        args: ["-I", "-B", "-u", "-X", "utf8", path.join(import.meta.dirname, "local-asr-child.py"), source, path.resolve(options.modelDirectory), output, signature, mode],
        cwd: path.resolve(options.cwd), cpuPercent: mode === "speech" ? 50 : 25, memoryLimitBytes: mode === "speech" ? 4 * 1024 ** 3 : 512 * 1024 ** 2, signal: input.signal });
      const saved = await savedOutput(output, maximumBytes) ?? await savedOutput(partial, maximumBytes);
      if (!saved) throw new Conflict("本地转写没有交付完整结果，原媒体已保留供重试");
      if (result.exitCode !== 0 || saved.error) {
        const stage = typeof saved.stage === "string" && ["imports", "inputs", "decode", "keyframes", "model_load", "recognition"].includes(saved.stage) ? saved.stage : "unknown";
        const kind = typeof saved.kind === "string" && ["MemoryError", "RuntimeError", "ValueError", "FileNotFoundError", "InvalidDataError", "PermissionError"].includes(saved.kind) ? saved.kind : "other";
        console.error(JSON.stringify({ event: "studio.local_asr.failed", mode, stage, kind, reason: saved.reason === "allocation_failed" ? "allocation_failed" : "other", peakCommitBytes: result.peakMemoryBytes, exitCode: result.exitCode }));
        throw new Conflict("本地转写未完成，请检查本地模型、媒体或运行依赖；原媒体保留供有限重试");
      }
      console.info(JSON.stringify({ event: "studio.local_asr.complete", mode, peakCommitBytes: result.peakMemoryBytes, cpuThreads: mode === "speech" ? 2 : 1 }));
      return decode(saved);
  }
  return { recognize: (input: Input) => invoke(input, "speech"), frames: (input: Input) => invoke(input, "frames") };
}
