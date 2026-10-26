import "./setup.ts";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { listenHttpForFetch } from "./http-listener.ts";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer(); await listenHttpForFetch(server);
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test("真实监督捕获API和网页日志，遮蔽已知密钥、丢弃超长行，并在状态中报告日志额度", { timeout: 30_000 }, async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/runtime-logs-integration-"));
  const file = path.join(folder, "config.env"), runDirectory = path.join(folder, "run");
  const bootstrap = path.join(folder, "bootstrap.mjs"), flood = path.join(folder, "output.mjs");
  const secret = "log-test-private-password-12345";
  await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=${secret}\nSESSION_SECRET=local-session-secret-1234567890\nIMG_PROXY_SIGN_SECRET=local-image-secret-1234567890\nAPI_PORT=${await freePort()}\nWEB_PORT=${await freePort()}\nAIHOT_DATA_DIR=${folder.replaceAll("\\", "/")}/data\n`);
  await writeFile(flood, `import {once} from 'node:events';
    process.stdout.write('secret-probe: '+(process.env.ADMIN_PASSWORD||'web')+'\\n');
    if(!process.stdout.write(Buffer.alloc(1024*1024,120)))await once(process.stdout,'drain');
    process.stdout.write('\\nEND_LOG_PROBE\\n');`);
  await writeFile(bootstrap, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const original=cp.spawn;cp.spawn=function(file,args,options){
      if(Array.isArray(args)&&args[0]?.endsWith('local-service.ts'))args=['--import',${JSON.stringify(pathToFileURL(flood).href)},...args];
      return original.call(this,file,args,options);
    };syncBuiltinESMExports();
    const {readLocalConfiguration}=await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/studio-config.ts")).href)});
    const {startLocal}=await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/studio-runtime.ts")).href)});
    await startLocal((await readLocalConfiguration(process.env.STUDIO_LOCAL_ENV)).env);`);
  const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_LOCAL_RUN_DIR: runDirectory };
  delete env.NODE_TEST_CONTEXT;
  const owner = spawn(process.execPath, [bootstrap], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const cli = (command: string) => exec(process.execPath, ["scripts/studio-local.ts", command], { env, timeout: 15_000, windowsHide: true });
  let verified = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("log fixture did not start")), 18_000);
      owner.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"state":"running"')) { clearTimeout(timeout); resolve(); } });
      owner.once("exit", () => { clearTimeout(timeout); reject(new Error("log fixture exited before readiness")); });
    });
    const api = await readFile(path.join(runDirectory, "api.log"), "utf8");
    assert.ok(!api.includes(secret), "监督落盘前必须遮蔽服务配置中的密钥");
    assert.ok(!api.includes("xxxxxxxx"), "超长无换行输出不能原样落盘");
    const status = JSON.parse((await cli("status")).stdout);
    assert.equal(status.logs.scope, "api_web");
    assert.equal(status.logs.limitBytes, 268435456);
    assert.ok(status.logs.droppedRecords >= 2);
    await assert.rejects(cli("resources"), error => {
      assert.deepEqual(JSON.parse((error as { stdout: string }).stdout), { ok: false, state: "unavailable" }, "组外夹具不能伪报完整资源观察");
      return true;
    });
    const exited = once(owner, "exit"); await cli("stop"); await exited;
    verified = true;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { await cli("stop").catch(() => {}); owner.kill(); }
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    if (verified) await rm(folder, { recursive: true, force: true });
  }
});
