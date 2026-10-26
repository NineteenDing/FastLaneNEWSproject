import "./setup.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

test("状态替换遭遇短暂EPERM后本机仍可正常启动和停止，持久故障仍必须拒绝运行", {timeout: 30000}, async () => {
  await mkdir(".local", {recursive: true}); const folder = await mkdtemp(path.resolve(".local/runtime-transient-"));
  const file = path.join(folder, "config.env"), probe = path.join(folder, "os-transient.mjs");
  async function freePort() {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as {port: number}).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
  }
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_USERNAME=film-editor\nADMIN_PASSWORD=local-test-password-12345\nSESSION_SECRET=local-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=local-image-secret-1234567890\nAPI_PORT=${await freePort()}\nWEB_PORT=${await freePort()}\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\n`);
  await writeFile(probe, `import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;let blocked=2;
    fs.renameSync=function(from,to){if(path.basename(String(to))==='windows-group.json'&&blocked-->0)throw Object.assign(Error('transient sharing conflict'),{code:'EPERM'});return original.call(this,from,to)};syncBuiltinESMExports();`);
  const env: NodeJS.ProcessEnv = {...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: path.join(folder, "run")}; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", pathToFileURL(probe).href, "scripts/studio-local.ts", "start"], {env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true});
  let output = "", running = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Transient file conflict prevented readiness")), 18000);
      child.stdout.on("data", chunk => {output += String(chunk); if(output.includes('"state":"running"')) {clearTimeout(timeout); resolve();}});
      child.once("exit", () => {clearTimeout(timeout); reject(Error(`Runtime exited before readiness: ${output}`));});
    });
    running = true;
    const status = JSON.parse((await exec(process.execPath, ["scripts/studio-local.ts", "status"], {env, timeout: 5000, windowsHide: true})).stdout);
    assert.equal(status.state, "running"); assert.equal(status.resources.state, "protected");
    for (const username of ["admin", "film-editor"]) {
      const login = await fetch(`${status.api}/api/auth/password`, { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password: "local-test-password-12345" }) });
      assert.equal(login.status, 303);
      assert.equal(!!login.headers.get("set-cookie"), username === "film-editor", "自定义用户名须通过实际本机API子进程生效");
    }
    const exit = once(child, "exit");
    const stopped = JSON.parse((await exec(process.execPath, ["scripts/studio-local.ts", "stop"], {env, timeout: 10000, windowsHide: true})).stdout);
    assert.equal(stopped.state, "stopped"); await exit; running = false;
  } finally { if(running) await exec(process.execPath, ["scripts/studio-local.ts", "stop"], {env, timeout: 10000, windowsHide: true}); }
});

test("资源状态替换失败时CLI报告安全操作与错误码，保留未确认状态，不只报通用启动失败", async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/runtime-publication-"));
  const file = path.join(folder, "config.env"), probe = path.join(folder, "os-fault.mjs");
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=local-test-password-12345\nSESSION_SECRET=local-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=local-image-secret-1234567890\nAPI_PORT=4351\nWEB_PORT=4352\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\n`);
  await writeFile(probe, `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;
    fs.renameSync=function(from,to){
      if(path.basename(String(to))==='windows-group.json')throw Object.assign(new Error('private-path-token-DO-NOT-PRINT'),{code:'EPERM'});
      return original.call(this,from,to);
    };syncBuiltinESMExports();`);
  const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: path.join(folder, "run") };
  delete env.NODE_TEST_CONTEXT;
  const failure = await exec(process.execPath, ["--import", pathToFileURL(probe).href, "scripts/studio-local.ts", "start"],
    { env, timeout: 15_000, windowsHide: true }).then(() => { throw new Error("故障注入未能拒绝启动"); }, error => error as { stdout: string; stderr: string; code: number });
  const result = JSON.parse(failure.stdout.trim());
  assert.equal(failure.code, 1);
  assert.equal(result.code, "LOCAL_RESOURCE_STATE_WRITE_FAILED");
  assert.match(result.message, /替换.*EPERM/);
  assert.ok(!(failure.stdout + failure.stderr).includes("DO-NOT-PRINT"));
  assert.ok(!failure.stdout.includes(folder));
  const statusFailure = await exec(process.execPath, ["scripts/studio-local.ts", "status"], { env, timeout: 5000, windowsHide: true })
    .then(() => { throw new Error("不能把资源状态写入故障报告成正常停止"); }, error => error as { stdout: string });
  assert.equal(JSON.parse(statusFailure.stdout).code, "LOCAL_RESOURCE_STATE_UNCONFIRMED");
  // Intentional failure retains its tiny owned record/config for diagnosis; no recovery or deletion is guessed.
});
