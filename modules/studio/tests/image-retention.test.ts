import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import fs, { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { studio } from "../server.ts";
import { createImageAssets } from "../backend/image-assets.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { convertAnimated, produceImage } from "@aihot/backend/media/images";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;

afterEach(async () => {
  installModules([]);
  const root = path.resolve(config.dataDir);
  assert.match(path.basename(path.dirname(root)), /^aihot-test-\d+-/);
  for (const leaf of ["imgcache", "ogcache", "studio/source-icons"]) {
    const owned = path.resolve(root, leaf);
    assert.ok(owned.startsWith(root + path.sep));
    await rm(owned, { recursive: true, force: true });
  }
});
after(async () => { setGlobalDispatcher(previous); await transport.close(); await stopBoss(); await closeDb(); });

test("日常图片清理遇到拒删时报告失败，保留文件并可在下次任务重试", async () => {
  installModules([studio]);
  const directory = path.join(config.dataDir, "imgcache");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "expired-fixture");
  await writeFile(file, "still-on-disk");
  const old = new Date(Date.now() - 40 * 86400_000);
  await utimes(file, old, old);
  const unlink = fs.unlink;
  const fault = mock.method(fs, "unlink", async (target: Parameters<typeof unlink>[0]) => {
    if (target === file) throw Object.assign(new Error("private-denied-file-fixture"), { code: "EACCES" });
    return unlink(target);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(dailyRetention(), /图片缓存清理失败/);
    assert.equal(await readFile(file, "utf8"), "still-on-disk");
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await dailyRetention()).prunedCache, 1);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal((await dailyRetention()).prunedCache, 0);
});

test("旧头像仍被新闻源引用时保留，仅移除过期无引用头像并保留新缓存", async () => {
  const { app, headers } = await sourceResourceFixture();
  const images = createImageAssets();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "retention-avatar", name: "旧头像来源", kind: "web_list", config: { url: "https://retention-avatar.example/news", itemSelector: "article" } } })).statusCode, 200);
    const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=retention-avatar", headers })).json().rows[0];
    transport.get("https://retention-avatar.example").intercept({ path: "/news" })
      .reply(200, '<html><link rel="icon" href="/icon.svg"></html>');
    transport.get("https://retention-avatar.example").intercept({ path: "/icon.svg" })
      .reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#216560"/></svg>', { headers: { "content-type": "image/svg+xml" } });
    const before = await read();
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/retention-avatar/refresh-profile", headers,
      payload: { version: before.version, profileVersion: before.profileVersion } })).statusCode, 200);
    const card = await read();
    const key = new URL(card.avatarUrl, "http://localhost").searchParams.get("v")!;
    const image = await images.read(key);
    assert.ok(image);
    const directory = path.join(config.dataDir, "studio/source-icons");
    await mkdir(directory, { recursive: true });
    const avatar = path.join(directory, key), unused = path.join(directory, "unused-legacy-avatar");
    await writeFile(avatar, image.body); await writeFile(unused, "unused-avatar");
    const old = new Date(Date.now() - 40 * 86400_000);
    await utimes(avatar, old, old); await utimes(unused, old, old);
    // A public lifecycle creates the pre-pool state: metadata still points at the legacy copy.
    await images.setReferences("source-avatar:retention-avatar", []);
    await images.prune(new Date(Date.now() + 60_000));
    assert.equal(await images.read(key), null);
    assert.equal((await app.inject({ url: card.avatarUrl, headers })).statusCode, 200);
    await mkdir(path.join(config.dataDir, "ogcache"), { recursive: true });
    const fresh = path.join(config.dataDir, "ogcache/fresh-fixture");
    await writeFile(fresh, "new-cache");
    assert.equal((await dailyRetention()).prunedCache, 1);
    await assert.rejects(readFile(unused), { code: "ENOENT" });
    assert.equal(await readFile(fresh, "utf8"), "new-cache");
    const kept = await app.inject({ url: card.avatarUrl, headers });
    assert.equal(kept.statusCode, 200);
    assert.deepEqual(kept.rawPayload, image.body);
  } finally { await app.close(); }
});

test("清理等待正在发布的图片完成，不能删除旧缓存或刚写入的替代图片", async () => {
  installModules([studio]);
  const frames = await sharp({ create: { width: 160, height: 1200, channels: 3,
    background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).raw().toBuffer();
  const gif = await sharp(frames, { raw: { width: 160, height: 1200, channels: 3, pageHeight: 120 } })
    .gif({ loop: 0, delay: Array(10).fill(90) }).toBuffer();
  const url = "https://retention-image.example/active.gif";
  transport.get("https://retention-image.example").intercept({ path: "/active.gif" })
    .reply(200, gif, { headers: { "content-type": "image/gif" } });
  assert.equal((await produceImage(url, "full")).type, "image/gif");
  const root = path.join(config.dataDir, "imgcache");
  const meta = (await fs.readdir(root, { recursive: true })).find(file => file.endsWith(".type"))!;
  assert.ok(meta);
  const bodyFile = path.join(root, meta.slice(0, -5));
  const old = new Date(Date.now() - 40 * 86400_000);
  await utimes(bodyFile, old, old); await utimes(`${bodyFile}.type`, old, old);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const rename = fs.rename;
  const publication = mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    if (args[1] === bodyFile) { entered.resolve(); await release.promise; }
    return rename(...args);
  });
  syncBuiltinESMExports();
  let cleanup: ReturnType<typeof dailyRetention> | undefined;
  const writing = convertAnimated(url, "full");
  try {
    assert.equal(await Promise.race([entered.promise.then(() => true), delay(3000, false)]), true);
    let settled = false;
    cleanup = dailyRetention().finally(() => { settled = true; });
    await delay(200);
    assert.equal(settled, false, "写入尚未发布，清理必须等待");
    assert.deepEqual(await readFile(bodyFile), gif);
    release.resolve();
    assert.ok(await writing > 0);
    assert.equal((await cleanup).prunedCache, 0, "发布后的缓存属于新文件");
    const result = await produceImage(url, "full");
    assert.equal(result.type, "image/webp");
    const animation = await sharp(result.body, { animated: true }).metadata();
    assert.equal(animation.pages, 10); assert.equal(animation.loop, 0);
    assert.deepEqual(animation.delay, Array(10).fill(90));
  } finally {
    release.resolve(); await Promise.allSettled([writing, ...(cleanup ? [cleanup] : [])]);
    publication.mock.restore(); syncBuiltinESMExports();
  }
});
