// Local-only process ownership and control. Worker and collection/model permissions are opt-in.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { access, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { replaceResourceRecordSync } from "./studio-resource-record.ts";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localProcessEnvironment } from "./local-environment.ts";
import { runWindowsProcessGroup } from "../modules/studio/backend/windows-process-group.ts";
import { readWindowsProcessGroupMessage, type WindowsProcessGroupStatus } from "../modules/studio/backend/windows-process-group-protocol.ts";
import { readLocalControlResponse, type LocalControlResponse, type LocalResourceStatus, type LocalRuntimeStatus } from "./studio-control-protocol.ts";
import { LocalError } from "./studio-config.ts";
import { createRuntimeLogs } from "../modules/studio/backend/runtime-logs.ts";
import { inspectApplicationResources } from "../modules/studio/backend/application-resources.ts";
import { readApplicationResources } from "../modules/studio/backend/application-resources-protocol.ts";
import type { ApplicationResources } from "../modules/studio/contracts.ts";

const root = path.resolve(import.meta.dirname, "..");
function withinLocal(value: string) {
  const resolved = path.resolve(root, value);
  const relative = path.relative(path.join(root, ".local"), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("LOCAL_PATH_REFUSED");
  return resolved;
}
const runDir = withinLocal(process.env.STUDIO_LOCAL_RUN_DIR || ".local/run");
const stateFile = path.join(runDir, "studio.json");
const groupFile = path.join(runDir, "windows-group.json");
type State = { root: string; port: number; token: string };
type ResourceRecord = { id: string; updatedAt: number; status: WindowsProcessGroupStatus & { type: "status" } };

export async function controlLocal(command: "status" | "stop" | "resources", options: { waitForGroupExit?: boolean } = {}): Promise<LocalControlResponse | ApplicationResources> {
  let state: State;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const pending = await access(groupFile).then(() => true, failure => {
        if (failure.code === "ENOENT") return false;
        throw new Error("LOCAL_RESOURCE_STATE_UNCONFIRMED");
      });
      if (pending) throw new Error("LOCAL_RESOURCE_STATE_UNCONFIRMED");
      return command === "resources" ? { ok: false, state: "unavailable" } : { ok: true, state: "stopped" };
    }
    throw new Error("LOCAL_STATE_INVALID");
  }
  if (state.root !== root || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.token)) throw new Error("LOCAL_STATE_INVALID");
  // Windows can assign port 6000 (and other browser-blocked ports). This is a local
  // operator protocol, so use HTTP directly instead of Fetch's browser port restrictions.
  const result = await new Promise<LocalControlResponse | ApplicationResources>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: state.port, path: `/${command}`,
      method: command === "stop" ? "POST" : "GET", headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(command === "stop" ? 210_000 : 15_000),
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("LOCAL_CONTROL_REFUSED")); return; }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
        if (body.length > 16_384) res.destroy(new Error("LOCAL_STATE_INVALID"));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const raw: unknown = JSON.parse(body);
          const response = command === "resources" ? readApplicationResources(raw) : readLocalControlResponse(raw);
          if (!response || (command === "stop" && response.state !== "stopped")) throw new Error();
          resolve(response);
        } catch { reject(new Error("LOCAL_STATE_INVALID")); }
      });
    });
    req.on("error", () => reject(new Error("LOCAL_CONTROL_UNAVAILABLE")));
    req.end();
  });
  if (command === "stop" && options.waitForGroupExit !== false) {
    const deadline = Date.now() + 8000;
    while (await access(groupFile).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw new Error("LOCAL_RESOURCE_STATE_UNCONFIRMED");
    })) {
      if (Date.now() >= deadline) throw new Error("LOCAL_RESOURCE_STATE_UNCONFIRMED");
      await delay(50);
    }
  }
  return result;
}

async function resourceView(groupId: string | undefined, worker: boolean): Promise<LocalResourceStatus> {
  if (!groupId) return { state: "unprotected" };
  try {
    const raw: unknown = JSON.parse(await readFile(groupFile, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const record = raw as Record<string, unknown>;
    const status = readWindowsProcessGroupMessage(record.status);
    if (record.id !== groupId || typeof record.updatedAt !== "number" || !Number.isSafeInteger(record.updatedAt) || Math.abs(Date.now() - record.updatedAt) > 3000
      || status?.type !== "status" || status.rootProcessId !== process.pid) throw new Error();
    return { state: "protected", scope: worker ? "supervisor_api_web_worker_descendants" : "supervisor_api_web_descendants", cpuPercent: status.cpuPercent,
      memoryLimitBytes: status.memoryLimitBytes, activeProcesses: status.activeProcesses,
      excluded: ["postgres", "launcher", "job_controller"] };
  } catch { return { state: "unavailable" }; }
}

// Shared by the normal launcher and explicit native composite acceptance. ASR's nested 4GiB
// allowance is part of this cap, not an additional allocation. PG/controllers remain outside.
// Use page-aligned 5GiB: Windows rounds decimal caps down, breaking exact admission.
export const localRuntimeLimits = Object.freeze({ cpuPercent: 50, memoryLimitBytes: 5 * 1024 ** 3 });

/** Local service root. PostgreSQL and the small outer controllers remain explicitly excluded. */
export async function startLocalWindows(configurationFile: string) {
  const previous = await controlLocal("status");
  if (previous.state !== "stopped") throw new Error("LOCAL_ALREADY_RUNNING");
  await mkdir(runDir, { recursive: true });
  // New status/ownership writes cannot follow a run-directory junction out of this project.
  const actual = await realpath(runDir);
  const local = path.join(root, ".local");
  const relative = path.relative(local, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("LOCAL_PATH_REFUSED");
  const id = randomBytes(32).toString("hex");
  const lease = await open(groupFile, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("LOCAL_ALREADY_RUNNING");
    throw error;
  });
  await lease.close();
  const controller = new AbortController();
  let lastWrite = 0, lastCount = -1, ended = false, confirmed = false;
  let publicationError: LocalError | undefined;
  const running = runWindowsProcessGroup({ executable: process.execPath,
    args: [path.join(root, "scripts/studio-owned-runtime.ts"), configurationFile, runDir, id], cwd: root,
    ...localRuntimeLimits, signal: controller.signal,
    onStatus: status => {
      if (Date.now() - lastWrite < 500 && status.activeProcesses === lastCount) return;
      lastWrite = Date.now(); lastCount = status.activeProcesses;
      const temporary = path.join(runDir, `group-${id}.tmp`);
      const record: ResourceRecord = { id, updatedAt: lastWrite, status: { type: "status", ...status } };
      let operation = "写入";
      try {
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        operation = "替换";
        replaceResourceRecordSync(temporary, groupFile);
      } catch (error) {
        const raw = error instanceof Error && "code" in error ? error.code : undefined;
        const code = typeof raw === "string" && ["EACCES", "EPERM", "EBUSY", "ENOSPC", "ENOENT", "EIO", "EROFS", "EMFILE", "ENFILE"].includes(raw) ? raw : "UNKNOWN";
        publicationError = new LocalError("LOCAL_RESOURCE_STATE_WRITE_FAILED", `本机资源状态${operation}失败（${code}）；已请求资源组退出，运行状态未确认，保留所属记录供核对。`);
        throw publicationError;
      }
    },
  }).then(result => { ended = true; confirmed = true; return result; }, error => { ended = true; throw error; });
  void running.catch(() => {});
  const interrupt = () => { void controlLocal("stop", { waitForGroupExit: false }).catch(() => controller.abort(new Error("LOCAL_START_FAILED"))); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, interrupt);
  try {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (!ended && Date.now() < deadline) {
      try {
        const view = await controlLocal("status");
        if (view.state === "running" && view.resources.state === "protected" && view.resources.activeProcesses >= 3) {
          console.log(JSON.stringify(view)); ready = true; break;
        }
      } catch { /* Root has not yet established its private control listener. */ }
      await delay(100);
    }
    if (!ready) throw new Error("LOCAL_START_FAILED");
    if ((await running).exitCode !== 0) throw new Error("LOCAL_START_FAILED");
  } catch (error) {
    if (!ended) {
      await controlLocal("stop", { waitForGroupExit: false }).catch(() => {});
      controller.abort(error);
    }
    await running.catch(() => {});
    throw publicationError ?? error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, interrupt);
    if (confirmed) await unlink(groupFile);
  }
}

export async function startLocal(config: Record<string, string | undefined>, options: { groupId?: string } = {}) {
  const port = (name: string, fallback: number) => {
    const n = Number(config[name] || fallback);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("LOCAL_PORT_INVALID");
    return n;
  };
  const apiPort = port("API_PORT", 4311), webPort = port("WEB_PORT", 4310);
  if (apiPort === webPort) throw new Error("LOCAL_PORT_CONFLICT");
  for (const key of ["SESSION_SECRET", "IMG_PROXY_SIGN_SECRET", "ADMIN_PASSWORD"]) {
    if ((config[key]?.length ?? 0) < 12) throw new Error("LOCAL_AUTH_REQUIRED");
  }
  const dataDir = withinLocal(config.AIHOT_DATA_DIR || ".local/data");
  const workerEnabled = config["STUDIO_LOCAL_WORKER_ENABLED"] === "true";
  const collectionAllowed = config.COLLECT_ENABLED === "true";
  const modelsAllowed = config.MODEL_CALLS_ENABLED === "true";
  const mediaProcessingAllowed = collectionAllowed && config.STUDIO_MEDIA_ENABLED === "true";
  const serverMode = config.STUDIO_RUNTIME_MODE === "server";
  let publicUrl = `http://127.0.0.1:${webPort}`;
  if (serverMode) {
    const selected = new URL(config.SITE_URL || "");
    if (selected.protocol !== "https:" || selected.username || selected.password || selected.pathname !== "/" || selected.search || selected.hash)
      throw new Error("LOCAL_SERVER_URL_INVALID");
    publicUrl = selected.origin;
  }
  let workerReady = false;
  const env = localProcessEnvironment();
  Object.assign(env, {
    AIHOT_ENVIRONMENT: "local-studio", NODE_ENV: "production",
    API_HOST: "127.0.0.1", API_PORT: String(apiPort), WEB_HOST: "127.0.0.1", WEB_PORT: String(webPort),
    API_BASE_URL: `http://127.0.0.1:${apiPort}`, SITE_URL: publicUrl,
    MODEL_CALLS_ENABLED: String(modelsAllowed), COLLECT_ENABLED: String(collectionAllowed), STUDIO_MEDIA_ENABLED: String(mediaProcessingAllowed),
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", LOG_LEVEL: "error", TRUST_PROXY: String(serverMode),
  });
  if (config.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(root, config.PLAYWRIGHT_BROWSERS_PATH);
  const children: { role: "api" | "web" | "worker"; process: ChildProcess }[] = [];
  const captures: Promise<void>[] = [];
  let logs: Awaited<ReturnType<typeof createRuntimeLogs>> | undefined;
  const token = randomBytes(32).toString("hex");
  let ownsState = false, ready = false;
  let stopping: Promise<void> | undefined;
  let resourceInspection: Promise<ApplicationResources> | undefined;
  const view = async (): Promise<LocalRuntimeStatus> => ({ ok: ready, state: ready ? "running" : "starting", web: `http://127.0.0.1:${webPort}`,
    api: env.API_BASE_URL!, worker: workerEnabled ? workerReady ? "running" : "starting" : "disabled",
    externalActions: collectionAllowed ? modelsAllowed ? "models_and_collection_allowed" : "collection_allowed" : modelsAllowed ? "models_allowed" : "disabled",
    mediaProcessingAllowed, resources: await resourceView(options.groupId, workerEnabled),
    ...(logs ? { logs: await logs.status() } : {}) });
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
    if (req.method === "GET" && req.url === "/status") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await view())); return; }
    if (req.method === "GET" && req.url === "/resources") {
      res.setHeader("Content-Type", "application/json");
      if (!ready || !options.groupId || !config.DATABASE_URL) { res.end(JSON.stringify({ ok: false, state: "unavailable" })); return; }
      const pending = resourceInspection ??= inspectApplicationResources(config.DATABASE_URL, { file: groupFile, id: options.groupId });
      try { res.end(JSON.stringify(await pending)); }
      finally { if (resourceInspection === pending) resourceInspection = undefined; }
      return;
    }
    if (req.method === "POST" && req.url === "/stop") {
      void stop().then(() => { res.end(JSON.stringify({ ok: true, state: "stopped" } satisfies LocalControlResponse)); server.close(); });
      return;
    }
    res.writeHead(404); res.end();
  });
  function stop() {
    return stopping ??= (async () => {
      ready = false;
      await Promise.all(children.map(async ({ role, process: child }) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        // Existing stopBoss drains for up to 195 seconds; leave time for DB close and log flush.
        const timeout = setTimeout(() => child.kill("SIGKILL"), role === "worker" ? 200_000 : 5_000);
        try {
          if (child.connected) child.send({ type: "studio:shutdown" }, () => {});
          else child.kill("SIGTERM");
          await exited;
        } finally { clearTimeout(timeout); }
      }));
      await Promise.all(captures);
      await logs?.close();
      if (ownsState) { await unlink(stateFile); ownsState = false; }
    })();
  }
  try {
    await mkdir(runDir, { recursive: true });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const state = await open(stateFile, "wx", 0o600).catch(error => {
      if (error.code === "EEXIST") throw new Error("LOCAL_ALREADY_RUNNING");
      throw error;
    });
    ownsState = true;
    try { await state.writeFile(JSON.stringify({ root, port: (server.address() as { port: number }).port, token })); }
    finally { await state.close(); }
    const secrets = [config.ADMIN_PASSWORD, config.SESSION_SECRET, config.IMG_PROXY_SIGN_SECRET, config.DATABASE_URL].filter((value): value is string => !!value);
    logs = await createRuntimeLogs(runDir, { secrets, worker: workerEnabled });
    const roles: ("api" | "web" | "worker")[] = ["api", "web", ...(workerEnabled ? ["worker" as const] : [])];
    for (const role of roles) {
      const child = spawn(process.execPath, [path.join(root, "scripts/local-service.ts"), role], {
        cwd: root, env: role !== "web" ? { ...env, DATABASE_URL: config.DATABASE_URL,
          SESSION_SECRET: config.SESSION_SECRET, IMG_PROXY_SIGN_SECRET: config.IMG_PROXY_SIGN_SECRET,
          STUDIO_RSSHUB_NATIVE_DIRECTORY: config.STUDIO_RSSHUB_NATIVE_DIRECTORY, STUDIO_RSSHUB_BASE_URL: config.STUDIO_RSSHUB_BASE_URL,
          STUDIO_RSSHUB_BUILD_MANIFEST: config.STUDIO_RSSHUB_BUILD_MANIFEST,
          STUDIO_MEDIACRAWLER_PYTHON: config.STUDIO_MEDIACRAWLER_PYTHON, STUDIO_MEDIACRAWLER_SOURCE: config.STUDIO_MEDIACRAWLER_SOURCE,
          STUDIO_ASR_PYTHON: config.STUDIO_ASR_PYTHON, STUDIO_ASR_MODEL_DIRECTORY: config.STUDIO_ASR_MODEL_DIRECTORY,
          STUDIO_BACKUP_DIRECTORY: config.STUDIO_BACKUP_DIRECTORY, STUDIO_BACKUP_EXTERNAL: config.STUDIO_BACKUP_EXTERNAL,
          LLM_BUDGET_CNY_PER_DAY: config.LLM_BUDGET_CNY_PER_DAY, LLM_BUDGET_CNY_PER_MONTH: config.LLM_BUDGET_CNY_PER_MONTH,
          LLM_TOKEN_PER_CHAR: config.LLM_TOKEN_PER_CHAR,
          LLM_BASE_URL: config.LLM_BASE_URL, LLM_API_KEY: config.LLM_API_KEY, LLM_MODEL: config.LLM_MODEL,
          LLM_EXTRA_JSON: config.LLM_EXTRA_JSON, LLM_JSON_MODE: config.LLM_JSON_MODE, LLM_VISION: config.LLM_VISION,
          LLM_REASONING_TOKENS: config.LLM_REASONING_TOKENS, DEEPSEEK_BASE_URL: config.DEEPSEEK_BASE_URL,
          DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY, AIHOT_CREDENTIALS_DIR: config.AIHOT_CREDENTIALS_DIR,
          ADMIN_USERNAME: config.ADMIN_USERNAME ?? "admin", ADMIN_PASSWORD: config.ADMIN_PASSWORD, AIHOT_DATA_DIR: dataDir } : env,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      captures.push(logs.capture(role, child.stdout!), logs.capture(role, child.stderr!));
      children.push({ role, process: child });
      if (role === "worker") child.on("message", message => {
        if (message && typeof message === "object" && "type" in message && message.type === "studio:ready"
          && "role" in message && message.role === "worker") workerReady = true;
      });
      child.on("error", () => { process.exitCode = 1; void stop().finally(() => server.close()); });
      child.on("exit", () => {
        if (!stopping) { process.exitCode = 1; void stop().finally(() => server.close()); }
      });
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stopping) {
      try {
        const api = await fetch(`${env.API_BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
        const web = await fetch(`http://127.0.0.1:${webPort}/admin/login`, { signal: AbortSignal.timeout(1000) });
        await Promise.all([api.arrayBuffer(), web.arrayBuffer()]);
        if (api.ok && web.ok && (!workerEnabled || workerReady)) { ready = true; break; }
      } catch { /* Startup is bounded; a listener is not yet ready. */ }
      await delay(100);
    }
    if (!ready) throw new Error("LOCAL_START_FAILED");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop().finally(() => server.close()); });
    console.log(JSON.stringify(await view()));
  } catch (error) {
    await stop();
    server.close();
    throw error;
  }
}
