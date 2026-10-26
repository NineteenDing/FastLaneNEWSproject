import "./setup.ts";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getBoss, stopBoss, ensureQueue, QUEUES } from "@aihot/backend/jobs/queue";
import { closeDb } from "@aihot/backend/db";
import { runsOverview } from "@aihot/backend/admin/runs";
import { listenHttpForFetch } from "./http-listener.ts";

const exec = promisify(execFile);
after(async () => { await stopBoss(); await closeDb(); });
async function freePort() {
  const server = createServer(); await listenHttpForFetch(server);
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function fixture(workerPrelude?: (folder: string) => string, configuration = "") {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/worker-runtime-"));
  const file = path.join(folder, "config.env"), runDirectory = path.join(folder, "run");
  const apiPort = await freePort(), webPort = await freePort();
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=worker-test-password-12345\nSESSION_SECRET=worker-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=worker-image-secret-1234567890\nAPI_PORT=${apiPort}\nWEB_PORT=${webPort}\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\nSTUDIO_LOCAL_WORKER_ENABLED=true\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: runDirectory,
    MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "true", STUDIO_MEDIA_ENABLED: "true",
    STUDIO_MEDIACRAWLER_PYTHON: "parent-collector-must-not-leak", STUDIO_MEDIACRAWLER_SOURCE: "parent-source-must-not-leak",
    STUDIO_ASR_PYTHON: "parent-asr-must-not-leak", STUDIO_ASR_MODEL_DIRECTORY: "parent-model-must-not-leak" };
  await writeFile(file, configuration, { flag: "a" });
  delete env.NODE_TEST_CONTEXT;
  const cli = async (command: string) => JSON.parse((await exec(process.execPath, ["scripts/studio-local.ts", command],
    { env, timeout: 30_000, windowsHide: true })).stdout);
  let args = ["scripts/studio-local.ts", "start"];
  if (workerPrelude) {
    const prelude = path.join(folder, "worker-os.mjs"), bootstrap = path.join(folder, "bootstrap.mjs");
    await writeFile(prelude, workerPrelude(folder));
    // This fixture replaces only OS process launch/file operations; the real worker entry runs intact.
    await writeFile(bootstrap, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      const original=cp.spawn;cp.spawn=function(file,args,options){
        if(args?.[0]?.endsWith('local-service.ts')&&args[1]==='worker')args=['--import',${JSON.stringify(pathToFileURL(prelude).href)},...args];
        return original.call(this,file,args,options);
      };syncBuiltinESMExports();
      const {readLocalConfiguration}=await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/studio-config.ts")).href)});
      const {startLocal}=await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/studio-runtime.ts")).href)});
      await startLocal((await readLocalConfiguration(process.env.STUDIO_LOCAL_ENV)).env);`);
    args = [bootstrap];
  }
  const startedAt = Date.now();
  const owner = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(owner, "exit");
  let output = "";
  owner.stdout.on("data", chunk => { output += String(chunk); });
  owner.stderr.resume();
  return { folder, runDirectory, startedAt, api: `http://127.0.0.1:${apiPort}`, owner, exited, cli,
    async ready() {
      const deadline = Date.now() + 23_000;
      while (!output.includes('"state":"running"')) {
        if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`worker fixture exited before ready: ${output}`);
        if (Date.now() >= deadline) throw new Error("worker fixture startup expired");
        await delay(50);
      }
    },
    async close(verified: boolean) {
      if (owner.exitCode === null && owner.signalCode === null) await cli("stop").catch(() => {});
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await exited; }
      assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
      if (verified) await rm(folder, { recursive: true, force: true });
    },
  };
}

test("显式启用的真实worker与网页共用Windows资源组，处理持久任务并正常整体停止", { timeout: 60_000 }, async () => {
  const boss = await getBoss();
  const legacy: Array<{ name: string; id: string }> = [];
  for (const name of [QUEUES.analyze, QUEUES.group, QUEUES.digest, QUEUES.notifySelected, QUEUES.prepareMedia, QUEUES.republishSource]) {
    await ensureQueue(name);
    const id = await boss.send(name, { articleId: "pipeline-isolation-missing", storyId: -1, sourceId: "pipeline-isolation-missing" });
    assert.ok(id); legacy.push({ name, id });
  }
  await ensureQueue("cron.reports.compose", { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
  await boss.schedule("cron.reports.compose", "0 0 1 1 *");
  await boss.schedule("cron.reports.compose", "0 0 1 1 *", {}, { key: "old-key" });
  const timerId = await boss.send("cron.reports.compose", {}); assert.ok(timerId);
  legacy.push({ name: "cron.reports.compose", id: timerId });
  const runtime = await fixture();
  let verified = false;
  try {
    await runtime.ready();
    const schedules = await boss.getSchedules();
    assert.ok(!schedules.some(item => item.name === "cron.reports.compose"), "工作台启动必须停止全部旧日报定时键");
    assert.ok(!schedules.some(item => ["cron.content.translate", "cron.hot.rank", "cron.hot.snapshot", "cron.stories.links", "cron.ops.digest", "cron.seo.indexnow", "cron.feedback.forward", "cron.reports.source-health"].includes(item.name)));
    assert.ok(schedules.some(item => item.name === "cron.content.sweep"), "必要正文提取恢复保留");
    assert.ok(schedules.some(item => item.name === "cron.ops.retention"), "安全清理保留");
    assert.ok(schedules.some(item => item.name === "cron.studio.topic.schedule"), "Studio选题计划保留");
    const status = await runtime.cli("status");
    assert.equal(status.worker, "running");
    assert.equal(status.externalActions, "disabled");
    assert.equal(status.mediaProcessingAllowed, false);
    assert.equal(status.resources.state, "protected");
    assert.equal(status.resources.scope, "supervisor_api_web_worker_descendants");
    assert.equal(status.resources.cpuPercent, 50);
    assert.equal(status.resources.memoryLimitBytes, 5_368_709_120);
    assert.ok(status.resources.activeProcesses >= 4);
    assert.deepEqual(status.resources.excluded, ["postgres", "launcher", "job_controller"]);
    assert.equal(status.logs.scope, "api_web_worker");
    assert.equal(status.logs.limitBytes, 268435456, "worker日志与API/web共用原有额度，不另放行一份");
    const resources = await runtime.cli("resources");
    assert.equal(resources.state, "measured");
    assert.ok(resources.components[0].processes >= status.resources.activeProcesses, "worker开启时也遍历整个所属进程树");
    const login = await fetch(`${runtime.api}/api/auth/password`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=worker-test-password-12345" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    type WorkerProcess = { role: string; pid: number; alive: boolean };
    let worker: WorkerProcess | undefined;
    for (let index = 0; index < 40 && !worker; index++) {
      const runs = await (await fetch(`${runtime.api}/api/admin/runs`, { headers: { cookie } })).json() as { processes: WorkerProcess[] };
      worker = runs.processes.find(item => item?.role === "worker" && item.alive);
      if (!worker) await delay(50);
    }
    assert.ok(worker?.alive, "真实worker通过原有运行接口报告心跳");
    assert.ok(!(await boss.getSchedules()).some(item => item.name === "cron.sources.schedule"), "继承的采集开关不能打开本机外发");
    const id = await boss.send("cron.ops.recover", {});
    assert.ok(id);
    const deadline = Date.now() + 20_000;
    while ((await boss.getJobById("cron.ops.recover", id))?.state !== "completed") {
      assert.ok(Date.now() < deadline, "真实worker应完成持久任务"); await delay(100);
    }
    for (const item of legacy) {
      assert.equal((await boss.getJobById(item.name, item.id))?.state, "created", `${item.name}旧待办保留且不被领取`);
    }
    const log = await readFile(path.join(runtime.runDirectory, "worker.log"), "utf8");
    assert.ok(log.includes("worker started"));
    assert.ok(!log.includes("worker-test-password"));
    await runtime.cli("stop");
    assert.deepEqual(await runtime.exited, [0, null]);
    assert.equal((await runtime.cli("status")).state, "stopped");
    assert.throws(() => process.kill(worker!.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(path.join(runtime.runDirectory, "windows-group.json")), { code: "ENOENT" });
    assert.equal((await runtime.cli("check")).database, "ready", "独立PG不随资源组停止");
    verified = true;
  } finally { await runtime.close(verified); }
});

test("项目配置明确允许模型时API与真实worker可启动，网页仍能持久暂停且采集与推送保持关闭", { timeout: 40_000 }, async () => {
  const runtime = await fixture(undefined, "MODEL_CALLS_ENABLED=true\n");
  let verified = false;
  try {
    await runtime.ready();
    const login = await fetch(`${runtime.api}/api/auth/password`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=worker-test-password-12345" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(`${runtime.api}/api/admin/studio/model-operations`, { headers: { cookie } })).json();
    assert.equal(state.runtimeAllowed, true); assert.equal(state.enabled, true);
    const status = await runtime.cli("status"); assert.equal(status.worker, "running"); assert.equal(status.externalActions, "models_allowed");
    assert.ok(!(await (await getBoss()).getSchedules()).some(item => item.name === "cron.sources.schedule"));
    const { csrf } = await (await fetch(`${runtime.api}/api/admin/me`, { headers: { cookie } })).json();
    const paused = await fetch(`${runtime.api}/api/admin/studio/model-operations`, { method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ version: state.version, enabled: false }) });
    assert.equal(paused.status, 200); assert.equal((await paused.json()).enabled, false);
    assert.equal((await (await fetch(`${runtime.api}/api/admin/studio/model-connection`, { headers: { cookie } })).json()).runtimeEnabled, false);
    await runtime.cli("stop"); assert.deepEqual(await runtime.exited, [0, null]); verified = true;
  } finally { await runtime.close(verified); }
});

test("项目文件明确允许采集和本地媒体时真实worker注册调度，后台组件路径仅按项目配置传递", { timeout: 40_000 }, async () => {
  let observed: Record<string, string> | undefined;
  const probe = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => { observed = JSON.parse(body); res.end("received"); });
  });
  const origin = await listenHttpForFetch(probe);
  const runtime = await fixture(() => `import http from 'node:http';
    const names=['COLLECT_ENABLED','STUDIO_MEDIA_ENABLED','MODEL_CALLS_ENABLED','FEISHU_CONTENT_PUSH_ENABLED','INDEXNOW_SUBMIT_ENABLED',
      'STUDIO_MEDIACRAWLER_PYTHON','STUDIO_MEDIACRAWLER_SOURCE','STUDIO_ASR_PYTHON','STUDIO_ASR_MODEL_DIRECTORY'];
    await new Promise((resolve,reject)=>{const req=http.request(${JSON.stringify(origin)},{method:'POST'},res=>{res.resume();res.on('end',resolve)});
      req.on('error',reject);req.end(JSON.stringify(Object.fromEntries(names.map(name=>[name,process.env[name]]))))});`,
    "COLLECT_ENABLED=true\nSTUDIO_MEDIA_ENABLED=true\nSTUDIO_MEDIACRAWLER_PYTHON=runtime/configured-collector/Scripts/python.exe\nSTUDIO_MEDIACRAWLER_SOURCE=runtime/configured-source\nSTUDIO_ASR_PYTHON=runtime/configured-asr/Scripts/python.exe\nSTUDIO_ASR_MODEL_DIRECTORY=runtime/configured-model\n");
  let verified = false;
  try {
    await runtime.ready();
    const status = await runtime.cli("status");
    assert.equal(status.externalActions, "collection_allowed"); assert.equal(status.mediaProcessingAllowed, true);
    assert.deepEqual(observed, { COLLECT_ENABLED: "true", STUDIO_MEDIA_ENABLED: "true", MODEL_CALLS_ENABLED: "false",
      FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
      STUDIO_MEDIACRAWLER_PYTHON: "runtime/configured-collector/Scripts/python.exe", STUDIO_MEDIACRAWLER_SOURCE: "runtime/configured-source",
      STUDIO_ASR_PYTHON: "runtime/configured-asr/Scripts/python.exe", STUDIO_ASR_MODEL_DIRECTORY: "runtime/configured-model" });
    const schedules = await (await getBoss()).getSchedules();
    assert.ok(schedules.some(item => item.name === "cron.sources.schedule"));
    assert.ok(schedules.some(item => item.name === "cron.studio.creator.schedule"));
    const login = await fetch(`${runtime.api}/api/auth/password`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=worker-test-password-12345" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await (await fetch(`${runtime.api}/api/admin/me`, { headers: { cookie } })).json();
    const missing = await fetch(`${runtime.api}/api/admin/studio/media-processing/11111111-1111-4111-8111-111111111111`, {
      method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 404, "API也必须取得媒体许可：不存在的材料不能误报未启用，也不能执行下载");
    await runtime.cli("stop"); assert.deepEqual(await runtime.exited, [0, null]); verified = true;
  } finally { await runtime.close(verified); await new Promise<void>(resolve => probe.close(() => resolve())); }
});

test("真实受保护启动分别报告联合许可，并拒绝只开媒体或非true的采集开关", { timeout: 40_000 }, async () => {
  for (const scenario of [
    { configuration: "COLLECT_ENABLED=true\nMODEL_CALLS_ENABLED=true\nSTUDIO_MEDIA_ENABLED=false\n", actions: "models_and_collection_allowed" },
    { configuration: "COLLECT_ENABLED=TRUE\nMODEL_CALLS_ENABLED=yes\nSTUDIO_MEDIA_ENABLED=true\n", actions: "disabled" },
  ]) {
    const runtime = await fixture(undefined, scenario.configuration); let verified = false;
    try {
      await runtime.ready();
      const status = await runtime.cli("status");
      assert.equal(status.worker, "running"); assert.equal(status.resources.state, "protected");
      assert.equal(status.externalActions, scenario.actions); assert.equal(status.mediaProcessingAllowed, false);
      await runtime.cli("stop"); assert.deepEqual(await runtime.exited, [0, null]); verified = true;
    } finally { await runtime.close(verified); }
  }
});

test("停止真实worker时允许超过五秒的持久任务保存结果，再关闭进程和日志", { timeout: 70_000 }, async () => {
  const boss = await getBoss();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const deleting = new Promise<void>(resolve => { entered = resolve; });
  const gate = createServer(async (_req, res) => { entered(); await held; res.end("continue"); });
  const origin = await listenHttpForFetch(gate);
  const runtime = await fixture(folder => `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.unlink;const target=${JSON.stringify(path.join(folder, "data/imgcache/expired"))};
    fs.unlink=async function(file){if(String(file)===target)await(await fetch(${JSON.stringify(origin)},{signal:AbortSignal.timeout(30000)})).text();return original.call(this,file);};
    syncBuiltinESMExports();`);
  const expired = path.join(runtime.folder, "data/imgcache/expired");
  let verified = false, stopping: Promise<unknown> | undefined;
  try {
    await mkdir(path.dirname(expired), { recursive: true }); await writeFile(expired, "old cache");
    const old = new Date(Date.now() - 40 * 86_400_000); await utimes(expired, old, old);
    await runtime.ready();
    assert.equal((await runtime.cli("status")).worker, "running");
    const id = await boss.send("cron.ops.retention", {}); assert.ok(id);
    await Promise.race([deleting, delay(20_000).then(() => { throw new Error("真实保留任务未进入文件删除"); })]);
    assert.equal((await boss.getJobById("cron.ops.retention", id))?.state, "active");
    let stopped = false;
    stopping = runtime.cli("stop").then(result => { stopped = true; return result; });
    await delay(6_000);
    assert.equal(stopped, false, "不能沿用API/web的五秒超时强杀仍在保存任务的worker");
    await access(expired);
    release(); await stopping;
    assert.equal((await boss.getJobById("cron.ops.retention", id))?.state, "completed");
    await assert.rejects(access(expired), { code: "ENOENT" });
    assert.deepEqual(await runtime.exited, [0, null]);
    const log = await readFile(path.join(runtime.runDirectory, "worker.log"), "utf8");
    assert.ok(log.includes('"msg":"worker stopped"'));
    assert.ok(log.includes('"phase":"complete"'));
    verified = true;
  } finally {
    release(); await stopping?.catch(() => {}); await runtime.close(verified);
    await new Promise<void>(resolve => gate.close(() => resolve()));
  }
});

test("真实worker意外退出时关闭所属API/web，不把失去任务进程的实例继续报告为正常", { timeout: 35_000 }, async () => {
  await getBoss();
  const runtime = await fixture();
  let verified = false;
  try {
    await runtime.ready();
    let worker = (await runsOverview()).processes.find(item => item.role === "worker" && item.alive && new Date(item.startedAt).getTime() >= runtime.startedAt);
    for (let index = 0; index < 40 && !worker; index++) {
      await delay(50); worker = (await runsOverview()).processes.find(item => item.role === "worker" && item.alive && new Date(item.startedAt).getTime() >= runtime.startedAt);
    }
    assert.ok(worker);
    process.kill(worker.pid);
    assert.deepEqual(await runtime.exited, [1, null]);
    assert.equal((await runtime.cli("status")).state, "stopped");
    await assert.rejects(fetch(`${runtime.api}/api/health`));
    await assert.rejects(access(path.join(runtime.runDirectory, "windows-group.json")), { code: "ENOENT" });
    assert.equal((await runtime.cli("check")).database, "ready");
    verified = true;
  } finally { await runtime.close(verified); }
});
