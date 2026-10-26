import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { createImageAssets } from "../backend/image-assets.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { dailyRetention } from "@aihot/backend/operations/retention";

after(async () => { await stopBoss(); await closeDb(); });

test("长期图片和占用状态只能登录后读取，响应不泄露路径或引用所属记录", async () => {
  const { app, headers } = await sourceResourceFixture();
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const body = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const saved = await images.put({ body, type: "image/png" });
  await images.setReferences("private-draft-fixture", [saved.id]);
  try {
    const url = `/api/admin/studio/image-assets/${saved.id}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, body);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(String(response.headers["content-security-policy"]), /sandbox/);
    assert.equal((await app.inject({ url: "/api/admin/studio/image-assets" })).statusCode, 401);
    const status = await app.inject({ url: "/api/admin/studio/image-assets", headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers["cache-control"], "no-store");
    assert.equal(status.json().scope, "managed_image_allocations");
    assert.equal(status.json().storedBytes, body.length);
    assert.equal(status.json().pendingBytes, 0);
    assert.ok(!status.body.includes(config.dataDir) && !status.body.includes("private-draft-fixture"));
    assert.equal((await app.inject({ url: `/api/admin/studio/image-assets/${"0".repeat(64)}`, headers })).statusCode, 404);
  } finally {
    await images.setReferences("private-draft-fixture", []);
    await app.close();
  }
});

test("日常保留任务只清理过期无引用素材，受保护图片保持可读", async () => {
  const images = createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 });
  const kept = await images.put({ body: Buffer.from("kept-image-fixture"), type: "image/png" });
  const unused = await images.put({ body: Buffer.from("unused-image-fixture"), type: "image/png" });
  await images.setReferences("retention-fixture", [kept.id]);
  try {
    await dailyRetention(new Date(Date.now() + 31 * 86400_000));
    assert.equal(await images.read(unused.id), null);
    assert.ok(await images.read(kept.id));
  } finally { await images.setReferences("retention-fixture", []); }
});

test("素材文件读取故障通过私有接口返回固定诊断，不回传本机路径", async () => {
  const { app, headers } = await sourceResourceFixture();
  const saved = await createImageAssets({ availableBytes: async () => 20 * 1024 ** 3 }).put({ body: Buffer.from("private-read-failure-image"), type: "image/png" });
  const fault = mock.method(fs, "readFile", async () => { throw new Error("EACCES private-disk-path-fixture"); });
  syncBuiltinESMExports();
  try {
    const response = await app.inject({ url: `/api/admin/studio/image-assets/${saved.id}`, headers });
    assert.equal(response.statusCode, 500);
    assert.ok(!response.body.includes("private-disk-path-fixture"));
    assert.match(response.body, /图片素材读取失败/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); await app.close(); }
});
