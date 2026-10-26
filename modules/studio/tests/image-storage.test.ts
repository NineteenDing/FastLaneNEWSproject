import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import fs, { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules, serverModules } from "@aihot/backend/modules";
import { convertAnimated, produceImage } from "@aihot/backend/media/images";
import { renderOg } from "@aihot/backend/media/og";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import { createImageStorage } from "../backend/image-storage.ts";
import { createImageAssets } from "../backend/image-assets.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { stopBoss } from "@aihot/backend/jobs/queue";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
const png = await sharp({ create: { width: 50, height: 40, channels: 3, background: "#176b75" } }).png().toBuffer();
function upstream(name: string) {
  transport.get("https://image-storage.example").intercept({ path: `/${name}` }).reply(200, png, { headers: { "content-type": "image/png" } });
  return `https://image-storage.example/${name}`;
}
afterEach(async () => {
  installModules([]);
  await createImageAssets().prune(new Date(Date.now() + 60_000));
  const root = path.resolve(config.dataDir);
  assert.match(path.basename(path.dirname(root)), /^aihot-test-\d+-/);
  for (const leaf of ["imgcache", "ogcache", "studio/source-icons"]) {
    const owned = path.resolve(root, leaf);
    assert.ok(owned.startsWith(root + path.sep));
    await rm(owned, { recursive: true, force: true });
  }
});
after(async () => { setGlobalDispatcher(previous); await transport.close(); await stopBoss(); await closeDb(); });

test("新闻配图低盘时拒绝新增缓存，已缓存图片仍可读取", async () => {
  let free = 20 * 1024 ** 3;
  const storage = createImageStorage({ availableBytes: async () => free });
  installModules([{ name: "studio", imageCacheWrite: storage.write }]);
  const url = upstream("existing");
  const existing = await produceImage(url, "full");
  free = 4_699_999_999;
  await assert.rejects(produceImage(upstream("low-disk"), "full"), /图片存储空间不足/);
  assert.deepEqual(await produceImage(url, "full"), existing);
});

test("旧配图、分享图及头像实占与长期素材共用额度，两条新增入口都不能越额", async () => {
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const saved = await images.put({ body: png, type: "image/png" });
  for (const [leaf, bytes] of [["imgcache", 100], ["ogcache", 200], ["studio/source-icons", 300]] as const) {
    await mkdir(path.join(config.dataDir, leaf), { recursive: true });
    await writeFile(path.join(config.dataDir, leaf, "legacy-fixture"), Buffer.alloc(bytes));
  }
  const options = { availableBytes: async () => 20 * 1024 ** 3, limitBytes: 600 + png.length };
  await assert.rejects(createImageAssets(options).put({ body: Buffer.concat([png, Buffer.from("new")]), type: "image/png" }), /图片.*额度不足/);
  const storage = createImageStorage(options);
  installModules([{ name: "studio", imageCacheWrite: storage.write }]);
  await assert.rejects(produceImage(upstream("quota-denied"), "full"), /图片.*额度不足/);
  assert.deepEqual(await images.read(saved.id), { body: png, type: "image/png" });
});

test("分享卡片写盘同样服从空间保护，已有分享图低盘仍可复用", async () => {
  let free = 20 * 1024 ** 3;
  const storage = createImageStorage({ availableBytes: async () => free });
  installModules([{ name: "studio", imageCacheWrite: storage.write }]);
  const card = { kicker: "AI影视", title: "角色一致性与制作流程" };
  const saved = await renderOg(card);
  free = 4_699_999_999;
  await assert.rejects(renderOg({ ...card, title: "新的模型与工具" }), /图片存储空间不足/);
  assert.deepEqual(await renderOg(card), saved);
});

test("动画转换无收益时的准备标记也不能绕过低盘保护", async () => {
  let free = 20 * 1024 ** 3;
  const storage = createImageStorage({ availableBytes: async () => free });
  installModules([{ name: "studio", imageCacheWrite: storage.write }]);
  const gif = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ loop: 2, delay: [80, 160] }).toBuffer();
  transport.get("https://image-storage.example").intercept({ path: "/marker.gif" }).reply(200, gif, { headers: { "content-type": "image/gif" } });
  const url = "https://image-storage.example/marker.gif";
  assert.equal((await produceImage(url, "full")).type, "image/gif");
  free = 4_699_999_999;
  await assert.rejects(convertAnimated(url, "full"), /图片存储空间不足/);
  free = 20 * 1024 ** 3;
  assert.equal(await convertAnimated(url, "full"), 0);
  free = 4_699_999_999;
  assert.equal(await convertAnimated(url, "full"), 0, "已完成标记无需新增写入");
});

test("未发布素材的预留和无记录的崩溃残留同时计额，不能相互抵消", async () => {
  const pending = Buffer.concat([png, Buffer.from("pending")]);
  const fault = mock.method(fs, "rename", async () => { throw new Error("controlled staging failure"); });
  syncBuiltinESMExports();
  try { await assert.rejects(createImageAssets().put({ body: pending, type: "image/png" }), /controlled staging failure/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  const orphan = path.join(config.dataDir, "studio/image-assets/orphan-fixture.tmp");
  await writeFile(orphan, Buffer.alloc(123));
  try {
    const next = Buffer.concat([png, Buffer.from("next")]);
    const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3, limitBytes: pending.length + 123 + next.length - 1 });
    await assert.rejects(images.put({ body: next, type: "image/png" }), /图片.*额度不足/);
    assert.equal((await images.status()).pendingBytes, pending.length);
  } finally { await unlink(orphan); }
});

test("登录后可查看图片与缓存的共同占用，游客不能读取或得到内部路径", async () => {
  const { app, headers } = await sourceResourceFixture();
  await mkdir(path.join(config.dataDir, "imgcache"), { recursive: true });
  await writeFile(path.join(config.dataDir, "imgcache/status-fixture"), Buffer.alloc(123));
  const saved = await createImageAssets().put({ body: png, type: "image/png" });
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/image-storage" })).statusCode, 401);
    const response = await app.inject({ url: "/api/admin/studio/image-storage", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), { scope: "configured_image_storage", state: "normal", cacheBytes: 123,
      assetBytes: saved.bytes, usedBytes: 123 + saved.bytes, limitBytes: 3 * 1024 ** 3 });
    assert.ok(!response.body.includes(config.dataDir));
  } finally { await app.close(); }
});

test("签名配图接口明确返回容量等待，不能将低盘误报为上游失败或缓存错误", async () => {
  const fixture = await sourceResourceFixture();
  const { app } = fixture;
  await fixture.warm();
  const storage = createImageStorage({ availableBytes: async () => 4_699_999_999 });
  installModules(serverModules().map(module => module.name === "studio" ? { ...module, publication: undefined, imageCacheWrite: storage.write } : module));
  try {
    const response = await app.inject({ url: proxiedImage(upstream("http-low-disk"), "full")! });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["retry-after"], "60");
    assert.ok(!response.body.includes(config.dataDir));
  } finally { await app.close(); }
});

test("图片目录不可读时容量为未知并停止新增，私有状态不泄露文件系统错误", async () => {
  const fixture = await sourceResourceFixture();
  const { app, headers } = fixture;
  installModules(serverModules().map(module => ({ ...module, publication: undefined })));
  await fixture.warm();
  await mkdir(path.join(config.dataDir, "imgcache"), { recursive: true });
  const fault = mock.method(fs, "opendir", async () => { throw new Error("EACCES private-image-dir-fixture"); });
  syncBuiltinESMExports();
  try {
    const response = await app.inject({ url: "/api/admin/studio/image-storage", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { scope: "configured_image_storage", state: "unavailable", cacheBytes: null,
      assetBytes: null, usedBytes: null, limitBytes: 3 * 1024 ** 3 });
    assert.ok(!response.body.includes("private-image-dir-fixture"));
    const image = await app.inject({ url: proxiedImage(upstream("unreadable"), "full")! });
    assert.equal(image.statusCode, 503);
    assert.equal(image.headers["cache-control"], "no-store");
  } finally { fault.mock.restore(); syncBuiltinESMExports(); await app.close(); }
});

test("两个独立进程分别写缓存和长期素材时共用最后一份图片额度", async () => {
  const script = `import {createImageAssets} from './modules/studio/backend/image-assets.ts';
    import {createImageStorage} from './modules/studio/backend/image-storage.ts';
    import {installModules} from '@aihot/backend/modules';import {closeDb} from '@aihot/backend/db';
    import {produceImage} from '@aihot/backend/media/images';import {config} from '@aihot/backend/config';
    import {MockAgent,setGlobalDispatcher} from 'undici';
    const body=Buffer.from(process.argv.at(-3),'base64');const mode=process.argv.at(-2);
    const options={limitBytes:Number(process.argv.at(-1)),availableBytes:async()=>20*1024**3};
    const transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);config.allowPrivateNetworkFetch=true;
    try{if(mode==='asset')await createImageAssets(options).put({body,type:'image/png'});
      else{const storage=createImageStorage(options);installModules([{name:'studio',imageCacheWrite:storage.write}]);
        transport.get('https://image-storage-child.example').intercept({path:'/picture'}).reply(200,body,{headers:{'content-type':'image/png'}});
        await produceImage('https://image-storage-child.example/picture','full');}
      console.log(JSON.stringify({ok:true}));}
    catch(error){console.log(JSON.stringify({ok:false,message:error.message}));}
    finally{await transport.close();await closeDb();}`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const limitBytes = png.length + 30;
  const results = await Promise.all(["asset", "cache"].map(async mode => {
    const output = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, png.toString("base64"), mode, String(limitBytes)],
      { env, windowsHide: true, timeout: 10_000 });
    return JSON.parse(output.stdout) as { ok: boolean; message?: string };
  }));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.match(results.find(result => !result.ok)!.message!, /图片.*额度不足/);
  const status = await createImageStorage({ limitBytes }).status();
  assert.ok(status.usedBytes! > 0 && status.usedBytes! <= limitBytes);
});

test("旧向量缓存需要准备标记但空间不足时直接等待，不重新下载已有原图", async () => {
  const url = "https://image-storage.example/legacy-vector";
  // Legacy public cache format: fixture from before preparation markers existed.
  const key = createHash("sha256").update(`full|${url}`).digest("hex");
  const file = path.join(config.dataDir, "imgcache", key.slice(0, 2), key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/><desc>${"old metadata ".repeat(12000)}</desc></svg>`);
  await writeFile(`${file}.type`, "image/svg+xml");
  const storage = createImageStorage({ availableBytes: async () => 4_699_999_999 });
  installModules([{ name: "studio", imageCacheWrite: storage.write }]);
  // No upstream interceptor: a refetch would fail as an unrelated upstream error.
  await assert.rejects(produceImage(url, "full"), /图片存储空间不足/);
});
