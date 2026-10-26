// Manual only: actual installed native model + synthetic Chinese video + real API/web/worker/PG.
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { runWindowsProcessGroup } from "../backend/windows-process-group.ts";
import { localRuntimeLimits } from "../../../scripts/studio-runtime.ts";

async function freePort() {
  const server = createServer(); await listenHttpForFetch(server);
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return String(port);
}
test("真实中文视频转写与网页/API/worker共享父资源额度时完成并持续响应", { timeout: 400_000 }, async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/native-runtime-asr-"));
  const file = path.join(folder, "configuration.json"), runDir = path.join(folder, "run"), id = "b".repeat(64);
  await mkdir(runDir);
  await writeFile(file, JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: "native-runtime-test-password", SESSION_SECRET: "native-runtime-test-session-secret",
    IMG_PROXY_SIGN_SECRET: "native-runtime-test-image-secret", API_PORT: await freePort(), WEB_PORT: await freePort(),
    AIHOT_DATA_DIR: path.join(folder, "data"), STUDIO_LOCAL_RUN_DIR: runDir, STUDIO_LOCAL_WORKER_ENABLED: "true",
    COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", LOG_LEVEL: "error" }), { mode: 0o600 });
  let verified = false;
  let lastWrite = 0, lastCount = -1;
  try {
    const result = await runWindowsProcessGroup({ executable: process.execPath,
      args: [path.resolve("modules/studio/tests/runtime-asr-child.ts"), file, id], cwd: path.resolve("."),
      ...localRuntimeLimits, signal: AbortSignal.timeout(360_000), onStatus: status => {
        if (Date.now() - lastWrite < 500 && status.activeProcesses === lastCount) return;
        lastWrite = Date.now(); lastCount = status.activeProcesses;
        const temporary = path.join(runDir, "group.tmp");
        writeFileSync(temporary, JSON.stringify({ id, updatedAt: Date.now(), status: { type: "status", ...status } }));
        renameSync(temporary, path.join(runDir, "windows-group.json"));
      } });
    const diagnostic = await readFile(path.join(folder, "failure.json"), "utf8").catch(() => "");
    console.info(JSON.stringify({ nativeResult: result, diagnostic }));
    assert.equal(result.exitCode, 0, `本地模型不能被网页与后台共享的父内存额度中断；${diagnostic}`);
    const output = JSON.parse(await readFile(path.join(folder, "result.json"), "utf8"));
    assert.ok(output.text.includes("角色")); assert.equal(output.frames, 4);
    assert.ok(output.responses.length >= 10);
    assert.ok(output.responses.every((item: { api: number; web: number; elapsedMs: number }) => item.api === 200 && item.web === 200 && item.elapsedMs < 3000));
    for (const view of [output.before, output.during, output.after]) {
      assert.equal(view.state, "measured");
      assert.ok(view.memoryEstimateBytes < 6_000_000_000, "包括数据库与外层控制器的实际估计应低于6GB设计总上限");
    }
    const outsidePeak = Math.max(...[output.before, output.during, output.after].map(view =>
      view.memoryEstimateBytes - view.components[0].privateBytes));
    assert.ok(result.peakMemoryBytes + outsidePeak < 6_000_000_000, "实际运行组峰值加已观察到的组外最大估计仍须低于6GB");
    console.info(JSON.stringify({ nativeComposite: true, syntheticFixture: true, peakJobCommitBytes: result.peakMemoryBytes,
      observedOutsidePeakBytes: outsidePeak, peakPlusObservedOutsideBytes: result.peakMemoryBytes + outsidePeak,
      unavailableObservations: output.unavailableObservations,
      memoryEstimates: [output.before, output.during, output.after].map(view => view.memoryEstimateBytes),
      responseSamples: output.responses.length, slowestMs: Math.max(...output.responses.map((item: { elapsedMs: number }) => item.elapsedMs)) }));
    verified = true;
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    if (verified) await rm(folder, { recursive: true, force: true });
  }
});
