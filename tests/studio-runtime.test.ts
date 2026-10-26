import "./setup.ts";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listenHttpForFetch } from "./http-listener.ts";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await listenHttpForFetch(server);
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function retainRuntimeFailure(folder: string) {
  // Keep owned logs/config locally for diagnosis without printing credentials or masking the failure.
  await mkdir(path.resolve(".local/logs"), { recursive: true });
  await writeFile(path.resolve(".local/logs/runtime-failure-" + path.basename(folder) + ".json"), JSON.stringify({ folder }));
}

test("operator can start, inspect and stop only this project's local API and web", { timeout: 30_000 }, async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/runtime-test-"));
  const file = path.join(folder, "config.env");
  const apiPort = await freePort(), webPort = await freePort();
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=local-test-password-12345\nSESSION_SECRET=local-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=local-image-secret-1234567890\nAPI_PORT=${apiPort}\nWEB_PORT=${webPort}\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\n`);
  await writeFile(file, `STUDIO_RSSHUB_NATIVE_DIRECTORY=${folder.replaceAll("\\", "/")}\n`, { flag: "a" });
  const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: path.join(folder, "run"), MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "true" };
  delete env.NODE_TEST_CONTEXT;
  const cli = (command: string) => exec(process.execPath, ["scripts/studio-local.ts", command], { env, timeout: 15_000 });
  const child = spawn(process.execPath, ["scripts/studio-local.ts", "start"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let verified = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("local runtime did not become ready")), 18_000);
      child.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"state":"running"')) { clearTimeout(timeout); resolve(); } });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`local runtime exited before readiness: ${output}`)); });
    });
    const status = JSON.parse((await cli("status")).stdout);
    assert.equal(status.state, "running");
    assert.equal(status.web, `http://127.0.0.1:${webPort}`);
    assert.equal(status.worker, "disabled");
    assert.equal(status.externalActions, "disabled");
    assert.equal(status.resources.state, "protected");
    assert.equal(status.resources.scope, "supervisor_api_web_descendants");
    assert.equal(status.resources.cpuPercent, 50);
    assert.equal(status.resources.memoryLimitBytes, 5_368_709_120);
    assert.ok(status.resources.activeProcesses >= 3, "supervisor, real API and real web share one kernel group");
    assert.deepEqual(status.resources.excluded, ["postgres", "launcher", "job_controller"]);
    const usage = JSON.parse((await cli("resources")).stdout);
    assert.equal(usage.state, "measured");
    assert.equal(usage.scope, "runtime_and_database_cluster");
    assert.equal(usage.enforcement, "runtime_job_only");
    assert.deepEqual(usage.components.map((item: { role: string }) => item.role), ["runtime", "launcher", "job_controller", "database"]);
    assert.ok(usage.components.every((item: { processes: number; privateBytes: number; cpuTimeMs: number }) =>
      item.processes >= 1 && item.privateBytes > 0 && item.cpuTimeMs >= 0));
    assert.ok(usage.components[0].processes >= status.resources.activeProcesses, "实际进程快照涵盖资源组普通后代及本次观察器");
    assert.ok(usage.databaseMainSharedBytes > 0, "数据库主共享内存单列一次，不将各backend工作集相加");
    assert.ok(usage.memoryEstimateBytes > usage.components[0].privateBytes, "整套观察不能只计算网页资源组");
    assert.deepEqual(usage.unmeasured, ["other_shared_mappings", "database_dynamic_shared_memory", "nginx_and_service_host"]);
    assert.ok(!JSON.stringify(usage).includes("local-test-password"));
    assert.ok(!JSON.stringify(usage).includes(folder));
    const control = JSON.parse(await readFile(path.join(folder, "run/studio.json"), "utf8")) as { port: number; token: string };
    const readUsage = (authenticated: boolean) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: control.port, path: "/resources", signal: AbortSignal.timeout(10_000),
        headers: authenticated ? { authorization: `Bearer ${control.token}` } : {} }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
        response.on("error", reject); response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    assert.equal((await readUsage(false)).status, 403, "资源观察仍须已有回环控制令牌");
    const simultaneous = await Promise.all([readUsage(true), readUsage(true), readUsage(true)]);
    assert.ok(simultaneous.every(item => item.status === 200));
    assert.ok(simultaneous.every(item => JSON.parse(item.body).state === "measured"), "合并观察仍需取得实际读数，不能三个unknown冒充成功");
    assert.deepEqual(JSON.parse(simultaneous[0]!.body), JSON.parse(simultaneous[1]!.body), "并发资源读取共用正在进行的观察，不能多开扫描器");
    assert.deepEqual(JSON.parse(simultaneous[0]!.body), JSON.parse(simultaneous[2]!.body));
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200);
    assert.equal((await fetch(`${status.web}/admin/login`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/admin/me`)).status, 401);
    const login = await fetch(`http://127.0.0.1:${apiPort}/api/auth/password`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=admin&password=local-test-password-12345" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await fetch(`http://127.0.0.1:${apiPort}/api/admin/me`, { headers: { cookie } })).json() as { csrf: string };
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/admin/sources`, { method: "POST", headers: { cookie, "x-csrf-token": me.csrf, "content-type": "application/json" },
      body: JSON.stringify({ id: "src-qwen-blog", name: "原生运行配置", kind: "external", config: {} }) })).status, 200);
    const bridge = await (await fetch(`http://127.0.0.1:${apiPort}/api/admin/studio/news-sources/src-qwen-blog/bridge`, { headers: { cookie } })).json() as { runtimeState: string };
    assert.equal(bridge.runtimeState, "configured", "本机启动应读取操作员配置的RSSHub原生目录");
    assert.ok(!output.includes("local-test-password"));
    await assert.rejects(cli("start"), (error: unknown) => {
      const result = error as { stdout: string };
      return JSON.parse(result.stdout).code === "LOCAL_ALREADY_RUNNING";
    });
    assert.equal(JSON.parse((await cli("status")).stdout).state, "running", "a second start must not stop the owned instance");
    const exited = once(child, "exit");
    await cli("stop");
    assert.equal(JSON.parse((await cli("status")).stdout).state, "stopped");
    await assert.rejects(cli("resources"), (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, state: "unavailable" });
      return true;
    }, "停机后没有资源读数，不能成功返回stopped");
    await assert.rejects(access(path.join(folder, "run/windows-group.json")), { code: "ENOENT" });
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/api/health`));
    verified = true;
  } finally {
    if (child.exitCode === null) { await cli("stop").catch(() => {}); child.kill(); }
    if (verified) await rm(folder, { recursive: true, force: true });
    else await retainRuntimeFailure(folder).catch(() => {});
  }
});

test("Windows launcher crash closes its real API/web group and preserves uncertain ownership", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(path.resolve(".local/runtime-crash-"));
  const file = path.join(folder, "config.env"), runDirectory = path.join(folder, "run");
  const apiPort = await freePort(), webPort = await freePort();
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=local-test-password-12345\nSESSION_SECRET=local-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=local-image-secret-1234567890\nAPI_PORT=${apiPort}\nWEB_PORT=${webPort}\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: runDirectory };
  delete env.NODE_TEST_CONTEXT;
  const cli = (command: string) => exec(process.execPath, ["scripts/studio-local.ts", command], { env, timeout: 15_000 });
  const owner = spawn(process.execPath, ["scripts/studio-local.ts", "start"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let verified = false;
  try {
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("crash fixture did not start")), 18_000);
      owner.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"state":"running"')) { clearTimeout(timeout); resolve(); } });
      owner.once("exit", code => { clearTimeout(timeout); reject(new Error(`crash fixture exited before readiness (${code}): ${output}`)); });
    });
    const exited = once(owner, "exit");
    owner.kill();
    await exited;
    let closed = false;
    for (let tries = 0; tries < 60; tries++) {
      const available = await Promise.all([apiPort, webPort].map(port => fetch(`http://127.0.0.1:${port}/`,
        { signal: AbortSignal.timeout(200) }).then(response => { void response.body?.cancel(); return true; }, () => false)));
      if (available.every(value => !value)) { closed = true; break; }
      await delay(50);
    }
    assert.equal(closed, true, "both real listeners must exit after losing their owner");
    assert.equal(JSON.parse((await cli("check")).stdout).database, "ready", "independent PostgreSQL remains usable");
    await access(path.join(runDirectory, "windows-group.json"));
    await assert.rejects(cli("start"), error => ["LOCAL_CONTROL_UNAVAILABLE", "LOCAL_RESOURCE_STATE_UNCONFIRMED"].includes(
      JSON.parse((error as { stdout: string }).stdout).code));
    verified = true;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { await cli("stop").catch(() => {}); owner.kill(); }
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    if (verified) await rm(folder, { recursive: true, force: true });
    else await retainRuntimeFailure(folder).catch(() => {});
  }
});
