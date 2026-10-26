// Explicit native acceptance helper. Credentials stay in its private fixture file, never argv.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [file, groupId] = process.argv.slice(2);
if (!file || !groupId) throw new Error("Missing native acceptance fixture");
const configuration = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
if (!/_(test|ci)$/.test(new URL(configuration.DATABASE_URL!).pathname)) throw new Error("Test database required");
Object.assign(process.env, configuration);
const { startLocal, controlLocal } = await import("../../../scripts/studio-runtime.ts");
const { createLocalAsr } = await import("../backend/local-asr.ts");
const { createStorageWorkspaces } = await import("../backend/storage-workspaces.ts");
const { closeDb } = await import("@aihot/backend/db");
const root = path.resolve(import.meta.dirname, "../../..");
const manager = createStorageWorkspaces();
let workspace: Awaited<ReturnType<typeof manager.reserve>> | undefined;
let finished = false;
const responses: { api: number; web: number; elapsedMs: number }[] = [];
let probing: Promise<void> | undefined;
const recognitionController = new AbortController();
let recognizing: ReturnType<ReturnType<typeof createLocalAsr>["recognize"]> | undefined;
let recognitionCompleted = false;
let stage = "runtime_start";
const snapshots: unknown[] = [];
let unavailableObservations = 0;
async function observe() {
  // Process membership changes during startup/native child launch can make a safe snapshot
  // unavailable. Retry finitely and report that fact; never substitute invented counters.
  for (let attempt = 0; attempt < 3; attempt++) {
    const view = await controlLocal("resources");
    if (view.state === "measured") return view;
    unavailableObservations++;
    await delay(500);
  }
  throw new Error("Native composite resource observation unavailable after three attempts");
}
try {
  await startLocal(configuration, { groupId });
  stage = "workspace";
  workspace = await manager.reserve({ task: "native-composite-runtime-asr", category: "media", bytes: 520 * 1024 ** 2 });
  await manager.write(workspace.id, "source.media", (async function* () { yield await readFile(path.join(root, ".local/asr-quality/chinese-video.mp4")); })());
  const before = await observe();
  snapshots.push(before);
  stage = "recognition";
  probing = (async () => {
    while (!finished) {
      const started = Date.now();
      const [api, web] = await Promise.all([
        fetch(`http://127.0.0.1:${configuration.API_PORT}/api/health`, { signal: AbortSignal.timeout(3000) }),
        fetch(`http://127.0.0.1:${configuration.WEB_PORT}/admin/login`, { signal: AbortSignal.timeout(3000) }),
      ]);
      await Promise.all([api.arrayBuffer(), web.arrayBuffer()]);
      responses.push({ api: api.status, web: web.status, elapsedMs: Date.now() - started });
      await delay(500);
    }
  })();
  void probing.catch(() => {});
  recognizing = createLocalAsr({ python: path.join(root, "runtime/asr-env/Scripts/python.exe"),
    modelDirectory: path.join(root, "runtime/asr-model-large-v3-turbo-int8"), cwd: root })
    .recognize({ file: path.join(workspace.directory, "source.media"), signal: AbortSignal.any([recognitionController.signal, AbortSignal.timeout(300000)]) });
  void recognizing.then(() => { recognitionCompleted = true; }, () => {});
  await delay(10_000);
  const during = await observe();
  snapshots.push(during);
  const recognition = await recognizing;
  finished = true;
  await probing;
  const after = await observe();
  await writeFile(path.join(path.dirname(file), "result.json"), JSON.stringify({ before, during, after, responses, unavailableObservations,
    text: recognition.segments.map(segment => segment.text).join(""), frames: recognition.frames?.length }));
} catch (error) {
  await writeFile(path.join(path.dirname(file), "failure.json"), JSON.stringify({ stage, message: error instanceof Error ? error.message : "Native composite verification failed", responses: responses.length, snapshots }));
  console.error(error instanceof Error ? error.message : "Native composite verification failed");
  process.exitCode = 1;
} finally {
  finished = true;
  recognitionController.abort(new Error("Native acceptance finished"));
  await recognizing?.catch(() => {});
  await probing?.catch(() => {});
  // A rejected native run can include an unconfirmed Job exit. Keep its fixture files and
  // reservation in every such case, rather than treating a swallowed rejection as safe cleanup.
  if (workspace && (!recognizing || recognitionCompleted)) await manager.cleanup(workspace.id);
  await controlLocal("stop", { waitForGroupExit: false }).catch(() => {});
  await closeDb();
}
