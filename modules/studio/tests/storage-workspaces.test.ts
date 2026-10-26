import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsDeletePermissionScript } from "../../../tests/windows-delete-permission.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";

after(closeDb);
const GiB = 1024 ** 3;

test("两个独立进程在5.7GB空闲时共享预留，不能重复分配4.7GB留白", async () => {
  const first = createStorageWorkspaces({ availableBytes: async () => 5_700_000_000 });
  const second = createStorageWorkspaces({ availableBytes: async () => 5_700_000_000 });
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const script = `import {createStorageWorkspaces} from './modules/studio/backend/storage-workspaces.ts';
    import {closeDb} from '@aihot/backend/db';
    try { console.log(JSON.stringify({ok:true,workspace:await createStorageWorkspaces({availableBytes:async()=>5_700_000_000}).reserve({task:process.argv.at(-1),category:'media',bytes:768*1024**2})})); }
    catch(error){console.log(JSON.stringify({ok:false,message:error.message}));}finally{await closeDb();}`;
  const results = await Promise.all(["concurrent-video-a", "concurrent-video-b"].map(async task => {
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, task], { env, windowsHide: true, timeout: 10_000 });
    return JSON.parse(result.stdout) as { ok: boolean; message?: string; workspace?: { id: string } };
  }));
  try {
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok)!.message!, /可用空间不足/);
    assert.equal((await first.status()).reservedBytes, 768 * 1024 ** 2);
  } finally {
    for (const result of results) if (result.ok) await first.cleanup(result.workspace!.id);
  }
  assert.equal((await second.status()).reservedBytes, 0);
});

test("分类额度与系统盘留白同时限制，临时媒体2GiB、导出和备份中转各512MiB", async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 64 * GiB });
  for (const [category, bytes] of [["media", 1280 * 1024 ** 2], ["exports", 320 * 1024 ** 2], ["backup", 320 * 1024 ** 2]] as const) {
    const first = await manager.reserve({ task: "cap-" + category, category, bytes });
    try {
      await assert.rejects(manager.reserve({ task: "cap-more-" + category, category, bytes }), /分类额度不足/);
    } finally { await manager.cleanup(first.id); }
  }
});

test("同一任务重试或重建管理接口后沿用预留，重启不凭超时归还仍可能占盘的额度", async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const first = await manager.reserve({ task: "durable-media-task", category: "media", bytes: 1024 });
  try {
    const resumed = createStorageWorkspaces({ availableBytes: async () => 11 * GiB });
    const second = await resumed.reserve({ task: "durable-media-task", category: "media", bytes: 1024 });
    assert.equal(second.id, first.id);
    assert.equal((await resumed.status()).reservedBytes, 1024);
    await assert.rejects(resumed.reserve({ task: "durable-media-task", category: "media", bytes: 2048 }), /任务已有不同的预留/);
  } finally { await manager.cleanup(first.id); }
});

test("临时文件按实际写入字节守住任务预留，超限删本次半成品、保留额度并允许重试", async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const workspace = await manager.reserve({ task: "bounded-download", category: "media", bytes: 5 });
  async function* oversized() { yield Buffer.from("abc"); yield Buffer.from("def"); }
  async function* exact() { yield Buffer.from("abcde"); }
  try {
    await assert.rejects(manager.write(workspace.id, "video.mp4", oversized()), /超过任务预留/);
    await assert.rejects(access(path.join(workspace.directory, "video.mp4")));
    assert.equal((await manager.status()).reservedBytes, 5);
    assert.equal((await manager.write(workspace.id, "video.mp4", exact())).bytesWritten, 5);
    assert.equal(await readFile(path.join(workspace.directory, "video.mp4"), "utf8"), "abcde");
    await assert.rejects(manager.write(workspace.id, "audio.wav", exact()), /超过任务预留/);
  } finally { await manager.cleanup(workspace.id); }
  await assert.rejects(access(workspace.directory));
  assert.equal((await manager.status()).reservedBytes, 0);
});

test("预留后其他程序占盘时逐块停止写入，不突破系统留白且保留任务以便重试", async () => {
  let free = 20 * GiB;
  const manager = createStorageWorkspaces({ availableBytes: async () => free });
  const workspace = await manager.reserve({ task: "disk-pressure-during-write", category: "media", bytes: 6 });
  async function* content() { yield Buffer.from("abc"); }
  try {
    free = 4_700_000_002;
    await assert.rejects(manager.write(workspace.id, "video.mp4", content()), /写入空间不足/);
    await assert.rejects(access(path.join(workspace.directory, "video.mp4")));
    assert.equal((await manager.status()).reservedBytes, 6);
    free = 13 * GiB;
    assert.equal((await manager.write(workspace.id, "video.mp4", content())).bytesWritten, 3);
  } finally { await manager.cleanup(workspace.id); }
});

test("磁盘监测返回未知或异常字节数时停止分配，不能把监测故障当成无限空间", async () => {
  for (const free of [NaN, Infinity, -1, 100.5]) {
    const manager = createStorageWorkspaces({ availableBytes: async () => free });
    await assert.rejects(manager.reserve({ task: "invalid-disk-" + String(free), category: "media", bytes: 1 }), /无法确认磁盘可用空间/);
    await assert.rejects(manager.status(), /无法确认磁盘可用空间/);
  }
});

test("Windows文件拒删时保留预留和文件，解除占用后才能清理并归还额度", { skip: process.platform !== "win32" }, async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const workspace = await manager.reserve({ task: "cleanup-retry", category: "media", bytes: 10 });
  const file = path.join(workspace.directory, "video.mp4"), script = path.join(path.dirname(workspace.directory), workspace.id + "-permission.ps1");
  const permission = (restore = false) => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-LockedFile", file, ...(restore ? ["-Restore"] : [])], { windowsHide: true, timeout: 5000 });
  async function* content() { yield Buffer.from("abc"); }
  try {
    await manager.write(workspace.id, "video.mp4", content());
    await writeFile(script, windowsDeletePermissionScript);
    await permission();
    await assert.rejects(manager.cleanup(workspace.id), /清理失败.*保留预留/);
    assert.equal((await createStorageWorkspaces({ availableBytes: async () => 20 * GiB }).status()).reservedBytes, 10);
    await permission(true);
    assert.equal(await readFile(file, "utf8"), "abc");
  } finally {
    await permission(true); await unlink(script); await manager.cleanup(workspace.id);
  }
  assert.equal((await manager.status()).reservedBytes, 0);
});

test("更改数据目录后不能把旧任务当成新目录任务或误归还旧文件的预留", async () => {
  const original = config.dataDir, manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const workspace = await manager.reserve({ task: "root-change", category: "media", bytes: 10 });
  try {
    config.dataDir = path.join(original, "different-data-root");
    const moved = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
    await assert.rejects(moved.reserve({ task: "root-change", category: "media", bytes: 10 }), /存储位置.*变化/);
    await assert.rejects(moved.cleanup(workspace.id), /存储位置.*变化/);
    assert.equal((await moved.status()).reservedBytes, 10);
  } finally { config.dataDir = original; await manager.cleanup(workspace.id); }
});

test("只有登录后能读取实际存储状态，响应不泄露任务名称或磁盘路径", async () => {
  const { installModules } = await import("@aihot/backend/modules");
  const { SERVER_MODULES } = await import("@aihot/site/modules/server");
  const { buildApp } = await import("../../../apps/api/src/app.ts");
  const { stopBoss } = await import("@aihot/backend/jobs/queue");
  installModules(SERVER_MODULES);
  const app = await buildApp(), manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const workspace = await manager.reserve({ task: "private-task-name", category: "media", bytes: 7 });
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/storage" })).statusCode, 401);
    config.adminPassword = "storage-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=storage-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const response = await app.inject({ url: "/api/admin/studio/storage", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /no-store/);
    assert.equal(response.json().reservedBytes, 7);
    assert.equal(response.json().keepFreeBytes, 4_700_000_000);
    assert.ok(Number.isSafeInteger(response.json().availableBytes));
    assert.ok(!response.body.includes(workspace.directory) && !response.body.includes("private-task-name"));
  } finally { await manager.cleanup(workspace.id); await app.close(); await stopBoss(); }
});

test("磁盘空间突降后两个工作目录并行写入不能重复消耗最后的写入余量", async () => {
  const manager = createStorageWorkspaces({ availableBytes: async () => 20 * GiB });
  const a = await manager.reserve({ task: "parallel-write-a", category: "media", bytes: 2 });
  const b = await manager.reserve({ task: "parallel-write-b", category: "exports", bytes: 2 });
  const files = [path.join(a.directory, "video.mp4"), path.join(b.directory, "export.zip")];
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const script = `import {createStorageWorkspaces} from './modules/studio/backend/storage-workspaces.ts';
    import {stat} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {closeDb} from '@aihot/backend/db';
    const files=JSON.parse(process.argv.at(-1));
    const manager=createStorageWorkspaces({availableBytes:async()=>{
      let written=0;for(const file of files)written+=await stat(file).then(value=>value.size,()=>0);
      const free=4_700_000_003-written;await delay(300);return free;
    }});
    async function* content(){yield Buffer.from('ab');}
    try{await manager.status();await manager.write(process.argv.at(-3),process.argv.at(-2),content());console.log(JSON.stringify({ok:true}));}
    catch(error){console.log(JSON.stringify({ok:false,message:error.message}));}finally{await closeDb();}`;
  try {
    const results = await Promise.all([[a.id, "video.mp4"], [b.id, "export.zip"]].map(async ([id, name]) => {
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, id!, name!, JSON.stringify(files)], { env, windowsHide: true, timeout: 10_000 });
      return JSON.parse(result.stdout) as { ok: boolean; message?: string };
    }));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok)!.message!, /写入空间不足/);
  } finally { await manager.cleanup(a.id); await manager.cleanup(b.id); }
});
