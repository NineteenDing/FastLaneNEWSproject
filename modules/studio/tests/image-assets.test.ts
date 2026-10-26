import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { createImageAssets } from "../backend/image-assets.ts";
import { createStorageWorkspaces } from "../backend/storage-workspaces.ts";

after(closeDb);
afterEach(async () => {
  const images = createImageAssets();
  await images.setReferences("draft:a", []); await images.setReferences("draft:b", []);
  await images.prune(new Date(Date.now() + 60_000));
});

test("图片发布失败的持久预留仍约束临时任务，恢复重试不会重复占用", async () => {
  const body = Buffer.concat([png, Buffer.from("publication-failure")]);
  const availableBytes = async () => 4_700_000_000 + body.length;
  const images = createImageAssets({ availableBytes });
  const rename = fs.rename;
  let failing = true, failures = 0;
  const fault = mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    if (failing) { failures++; throw Object.assign(new Error("controlled publication failure"), { code: "EACCES" }); }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(images.put({ body, type: "image/png" }), /controlled publication failure/);
    assert.equal(failures, 1);
    assert.equal((await images.status()).pendingBytes, body.length);
    const temporary = createStorageWorkspaces({ availableBytes });
    assert.equal((await temporary.status()).reservedBytes, body.length);
    await assert.rejects(temporary.reserve({ task: "must-wait-for-image", category: "media", bytes: 1 }), /可用空间不足/);
    failing = false;
    const saved = await createImageAssets({ availableBytes }).put({ body, type: "image/png" });
    assert.deepEqual(await images.read(saved.id), { body, type: "image/png" });
    assert.equal((await images.status()).pendingBytes, 0);
    assert.equal((await temporary.status()).reservedBytes, 0);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

test("新增图片服从临时任务预留和4.7GB留白，空间不足时已保存图片仍可读取", async () => {
  let free = 5_773_741_824;
  const availableBytes = async () => free;
  const images = createImageAssets({ availableBytes });
  const existing = await images.put({ body: png, type: "image/png" });
  const temporary = createStorageWorkspaces({ availableBytes });
  const reserved = await temporary.reserve({ task: "video-has-priority-space", category: "media", bytes: 1024 ** 3 });
  try {
    await assert.rejects(images.put({ body: Buffer.concat([png, Buffer.from("not-enough-space")]), type: "image/png" }), /可用空间不足/);
    assert.equal((await images.status()).pendingBytes, 0, "被拒绝的新图片不留下虚假占用");
    free = 4_699_999_999;
    assert.deepEqual(await images.read(existing.id), { body: png, type: "image/png" });
    assert.equal((await images.put({ body: png, type: "image/png" })).id, existing.id, "已保存的同一内容不重复写盘");
  } finally { await temporary.cleanup(reserved.id); }
});

test("同一图片保存后可重建素材接口读取，重复内容只占一份容量", async () => {
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const first = await images.put({ body: png, type: "image/png" });
  const reopened = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const second = await reopened.put({ body: png, type: "image/png" });
  assert.equal(first.id, second.id);
  assert.deepEqual(await reopened.read(first.id), { body: png, type: "image/png" });
  const status = await reopened.status();
  assert.equal(status.storedBytes, png.length);
  assert.equal(status.pendingBytes, 0);
  assert.equal(status.limitBytes, 3 * 1024 ** 3);
});

test("预留后磁盘突降时不继续写图，保留持久预留并允许恢复后完成", async () => {
  const body = Buffer.concat([png, Buffer.from("disk-drop")]);
  let reads = 0;
  const images = createImageAssets({ availableBytes: async () => ++reads === 1 ? 4_700_000_000 + body.length : 4_699_999_999 });
  await assert.rejects(images.put({ body, type: "image/png" }), /可用空间不足/);
  assert.equal((await images.status()).storedBytes, 0);
  assert.equal((await images.status()).pendingBytes, body.length);
  const recovered = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const saved = await recovered.put({ body, type: "image/png" });
  assert.deepEqual(await recovered.read(saved.id), { body, type: "image/png" });
  assert.equal((await recovered.status()).pendingBytes, 0);
});

test("并发保存不同图片共用素材额度，不能各自分配最后一份空间", async () => {
  const bodies = [Buffer.concat([png, Buffer.from("quota-a")]), Buffer.concat([png, Buffer.from("quota-b")])];
  const options = { availableBytes: async () => 20 * 1024 ** 3, limitBytes: bodies[0]!.length + 1 };
  const images = createImageAssets(options);
  const results = await Promise.allSettled(bodies.map(body => createImageAssets(options).put({ body, type: "image/png" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected");
  assert.ok(failed && failed.status === "rejected");
  assert.match(String(failed.reason), /图片素材额度不足/);
  assert.equal((await images.status()).storedBytes, bodies[0]!.length);
  assert.equal((await images.status()).pendingBytes, 0);
  assert.equal((await images.prune(new Date(Date.now() + 60_000))).removed, 1);
});

test("两个所属记录引用同一图片时互不影响，只清理最后取消引用后的旧素材", async () => {
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const kept = await images.put({ body: png, type: "image/png" });
  const unused = await images.put({ body: Buffer.concat([png, Buffer.from("unused")]), type: "image/png" });
  await images.setReferences("draft:a", [kept.id]);
  await images.setReferences("draft:b", [kept.id]);
  const before = new Date(Date.now() + 60_000);
  assert.equal((await images.prune(before)).removed, 1);
  assert.equal(await images.read(unused.id), null);
  assert.deepEqual(await images.read(kept.id), { body: png, type: "image/png" });
  await images.setReferences("draft:a", []);
  assert.equal((await images.prune(before)).removed, 0);
  assert.ok(await images.read(kept.id));
  await images.setReferences("draft:b", []);
  assert.equal((await images.prune(before)).removed, 1);
  assert.equal(await images.read(kept.id), null);
  assert.equal((await images.status()).storedBytes, 0);
});

test("已开始的临时任务仍可在实测留白内完成，失败图片预留不被误标为完成", async () => {
  const body = Buffer.concat([png, Buffer.from("protect-pending-image")]);
  let free = 4_700_000_000 + body.length + 11;
  const availableBytes = async () => free;
  const temporary = createStorageWorkspaces({ availableBytes });
  const workspace = await temporary.reserve({ task: "reserved-before-image", category: "media", bytes: 10 });
  const fault = mock.method(fs, "rename", async () => { throw new Error("controlled image rename failure"); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createImageAssets({ availableBytes }).put({ body, type: "image/png" }), /controlled image rename failure/);
    free = 4_700_000_000 + body.length + 5;
    async function* chunks() { yield Buffer.from("123456"); }
    assert.equal((await temporary.write(workspace.id, "evidence.bin", chunks())).bytesWritten, 6);
    assert.equal((await createImageAssets().status()).pendingBytes, body.length);
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    await temporary.cleanup(workspace.id);
  }
});

test("临时图片拒删时重试不累计文件，清理失败保留额度，解除占用后完成", async () => {
  const body = Buffer.concat([png, Buffer.from("delete-denied")]);
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const opened = new Set<string>();
  const open = fs.open, rename = fs.rename, unlink = fs.unlink;
  let denied = true;
  const opening = mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    opened.add(String(args[0])); return open(...args);
  });
  const publishing = mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    if (denied) throw new Error("controlled publication failure");
    return rename(...args);
  });
  const deleting = mock.method(fs, "unlink", async (...args: Parameters<typeof unlink>) => {
    if (denied) throw Object.assign(new Error("controlled delete denied"), { code: "EACCES" });
    return unlink(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(images.put({ body, type: "image/png" }), /controlled delete denied/);
    await assert.rejects(images.put({ body, type: "image/png" }), /controlled delete denied/);
    let physicalBytes = 0;
    for (const file of opened) physicalBytes += await fs.stat(file).then(info => info.size, () => 0);
    assert.equal(physicalBytes, body.length, "失败重试不能再写一份临时图");
    await assert.rejects(images.prune(new Date(Date.now() + 60_000)), /controlled delete denied/);
    assert.equal((await images.status()).pendingBytes, body.length);
    denied = false;
    const saved = await images.put({ body, type: "image/png" });
    assert.deepEqual(await images.read(saved.id), { body, type: "image/png" });
    assert.equal((await images.status()).pendingBytes, 0);
    for (const file of opened) assert.equal(await fs.stat(file).then(info => info.size, () => 0), 0);
  } finally {
    opening.mock.restore(); publishing.mock.restore(); deleting.mock.restore(); syncBuiltinESMExports();
  }
});

test("所属事务回滚后保留原引用，不将未确认的新图当成已采用素材", async () => {
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const old = await images.put({ body: Buffer.concat([png, Buffer.from("transaction-old")]), type: "image/png" });
  const next = await images.put({ body: Buffer.concat([png, Buffer.from("transaction-new")]), type: "image/png" });
  await images.setReferences("draft:a", [old.id]);
  await assert.rejects(sql.begin(async tx => {
    await images.setReferences("draft:a", [next.id], tx);
    throw new Error("controlled owner rollback");
  }), /controlled owner rollback/);
  await images.prune(new Date(Date.now() + 60_000));
  assert.ok(await images.read(old.id));
  assert.equal(await images.read(next.id), null);
});

async function runImageChild(body: Buffer, mode: "save" | "fail-publication", limitBytes = 3 * 1024 ** 3) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const script = `import {createImageAssets} from './modules/studio/backend/image-assets.ts';
    import {closeDb} from '@aihot/backend/db';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const images=createImageAssets({availableBytes:async()=>20*1024**3,limitBytes:Number(process.argv.at(-1))});
    if(process.argv.at(-2)==='fail-publication'){fs.rename=async()=>{throw new Error('controlled child publication failure')};syncBuiltinESMExports()}
    try{const saved=await images.put({body:Buffer.from(process.argv.at(-3),'base64'),type:'image/png'});console.log(JSON.stringify({ok:true,...saved}));}
    catch(error){console.log(JSON.stringify({ok:false,message:error.message,status:await images.status()}));}
    finally{await closeDb();}`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, body.toString("base64"), mode, String(limitBytes)], { env, windowsHide: true, timeout: 10_000 });
  return JSON.parse(result.stdout) as { ok: boolean; id?: string; message?: string; status?: { pendingBytes: number } };
}

test("独立进程退出后保留未发布图片预留，新进程继续同一内容并完成读取", async () => {
  const body = Buffer.concat([png, Buffer.from("process-restart")]);
  const failed = await runImageChild(body, "fail-publication");
  assert.equal(failed.ok, false);
  assert.match(failed.message!, /controlled child publication failure/);
  assert.equal(failed.status!.pendingBytes, body.length);
  const completed = await runImageChild(body, "save");
  assert.equal(completed.ok, true);
  const images = createImageAssets();
  assert.deepEqual(await images.read(completed.id!), { body, type: "image/png" });
  assert.equal((await images.status()).pendingBytes, 0);
});

test("两个独立进程同时保存不同图片也只能占用一份剩余额度", async () => {
  const bodies = [Buffer.concat([png, Buffer.from("process-a")]), Buffer.concat([png, Buffer.from("process-b")])];
  const results = await Promise.all(bodies.map(body => runImageChild(body, "save", body.length + 1)));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.match(results.find(result => !result.ok)!.message!, /图片素材额度不足/);
  assert.equal((await createImageAssets().status()).storedBytes, bodies[0]!.length);
});
