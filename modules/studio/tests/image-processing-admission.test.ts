import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules, serverModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { produceImage } from "@aihot/backend/media/images";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import { buildApp } from "../../../apps/api/src/app.ts";
import { studio } from "../server.ts";
import { renderOg } from "@aihot/backend/media/og";
import { CARDS } from "@aihot/site";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
const png = await sharp({ create: { width: 50, height: 40, channels: 3, background: "#176b75" } }).png().toBuffer();
// Exercise the original signed-image resource contract; strict publication ownership is covered separately.
const resourceStudio = { ...studio, publication: undefined };
const resourceMode = () => installModules(serverModules().map(module => ({ ...module, publication: undefined })));
afterEach(async () => {
  installModules([]);
  const root = path.resolve(config.dataDir);
  assert.match(path.basename(path.dirname(root)), /^aihot-test-\d+-/);
  for (const leaf of ["imgcache", "ogcache"]) {
    const owned = path.resolve(root, leaf);
    assert.ok(owned.startsWith(root + path.sep));
    await rm(owned, { recursive: true, force: true });
  }
});
after(async () => { setGlobalDispatcher(previous); await transport.close(); await stopBoss(); await closeDb(); });

test("图片请求在主机尚未就绪时不下载或编码新图片，旧缓存仍能读取", async () => {
  installModules([resourceStudio]);
  transport.get("https://image-processing.example").intercept({ path: "/cached" }).reply(200, png, { headers: { "content-type": "image/png" } });
  const cachedUrl = "https://image-processing.example/cached";
  const cached = await produceImage(cachedUrl, "full");
  let requests = 0;
  transport.get("https://image-processing.example").intercept({ path: "/warming" }).reply(() => {
    requests++; return { statusCode: 200, data: png, responseOptions: { headers: { "content-type": "image/png" } } };
  });
  const app = await buildApp();
  try {
    const response = await app.inject({ url: proxiedImage("https://image-processing.example/warming", "full")! });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "60");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(requests, 0);
    const ready = await app.inject({ url: proxiedImage(cachedUrl, "full")! });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.rawPayload, cached.body);
  } finally { await app.close(); }
});

test("新分享图在主机尚未就绪时等待，旧分享图与条件读取保留原有行为", async () => {
  installModules([resourceStudio]);
  const cached = await renderOg(CARDS.site!);
  const app = await buildApp();
  try {
    const response = await app.inject({ url: "/og/pages/all.png" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "60");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.etag, undefined, "等待响应不能携带图片实体的验证器");
    const ready = await app.inject({ url: "/og/site.png" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.rawPayload, cached.png);
    assert.equal((await app.inject({ url: "/og/site.png", headers: { "if-none-match": String(ready.headers.etag) } })).statusCode, 304);
  } finally { await app.close(); }
});

test("旧向量缓存仍需编码或准备时不能绕过请求资源保护，也不能重新下载", async () => {
  installModules([resourceStudio]);
  const url = "https://image-processing.example/legacy-svg";
  const key = createHash("sha256").update(`full|${url}`).digest("hex");
  const file = path.join(config.dataDir, "imgcache", key.slice(0, 2), key);
  await mkdir(path.dirname(file), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/><desc>${"old metadata ".repeat(12000)}</desc></svg>`;
  await writeFile(file, svg); await writeFile(`${file}.type`, "image/svg+xml");
  const app = await buildApp();
  try {
    const response = await app.inject({ url: proxiedImage(url, "full")! });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(await readFile(file, "utf8"), svg);
    await assert.rejects(readFile(`${file}.prepared`), { code: "ENOENT" });
  } finally { await app.close(); }
});

test("实际API监测在内存、磁盘与数据库压力时暂停新图，按恢复线继续同一请求且不污染后台处理", async () => {
  const fixture = await sourceResourceFixture();
  resourceMode();
  const { app, capacity, api } = fixture;
  const requests = new Map<string, number>();
  const image = async (name: string) => app.inject({ url: proxiedImage(`https://image-processing.example/${name}`, "full")! });
  for (const name of ["memory", "disk", "database", "outside-request"]) {
    transport.get("https://image-processing.example").intercept({ path: `/${name}` }).reply(() => {
      requests.set(name, (requests.get(name) ?? 0) + 1);
      return { statusCode: 200, data: png, responseOptions: { headers: { "content-type": "image/png" } } };
    });
  }
  try {
    await fixture.warm();
    capacity.memoryBytes = 1024 ** 3; api.host.sample();
    assert.equal((await image("memory")).statusCode, 503);
    assert.equal(requests.get("memory") ?? 0, 0);
    // Outside HTTP the existing worker-owned admission remains responsible, with no stale request scope.
    const outside = await produceImage("https://image-processing.example/outside-request", "full");
    assert.equal((await image("outside-request")).statusCode, 200);
    assert.ok(outside.body.length > 0);
    capacity.memoryBytes = 4 * 1024 ** 3;
    api.host.sample();
    assert.equal((await image("memory")).statusCode, 503, "未经过恢复观察仍等待");
    await fixture.warm();
    assert.equal((await image("memory")).statusCode, 200);
    assert.equal(requests.get("memory"), 1, "资源等待不缓存成一分钟上游失败");
    capacity.diskBytes = 5_000_000_000; await api.disk.sample();
    assert.equal((await image("disk")).statusCode, 503);
    capacity.diskBytes = 5_900_000_000; await api.disk.sample();
    assert.equal((await image("disk")).statusCode, 503);
    assert.equal((await image("memory")).statusCode, 200, "压力期间仍读旧图");
    assert.equal(requests.get("disk") ?? 0, 0);
    capacity.diskBytes = 6_000_000_000; await api.disk.sample();
    assert.equal((await image("disk")).statusCode, 200);
    capacity.databaseBytes = 6 * 1024 ** 3; await api.database.sample();
    assert.equal((await image("database")).statusCode, 503);
    capacity.databaseBytes = 5.75 * 1024 ** 3; await api.database.sample();
    assert.equal((await image("database")).statusCode, 503);
    assert.equal(requests.get("database") ?? 0, 0);
    capacity.databaseBytes = 5.5 * 1024 ** 3; await api.database.sample();
    assert.equal((await image("database")).statusCode, 200);
  } finally { await app.close(); }
});

test("并发请求各用所属API的资源状态，关闭受限API不影响另一个正常API", async () => {
  const limited = await sourceResourceFixture();
  const ready = await sourceResourceFixture();
  resourceMode();
  for (const name of ["limited-app", "ready-app", "after-other-close"]) {
    transport.get("https://image-processing.example").intercept({ path: `/${name}` })
      .reply(200, png, { headers: { "content-type": "image/png" } });
  }
  try {
    await limited.warm(); await ready.warm();
    limited.capacity.memoryBytes = 1024 ** 3; limited.api.host.sample();
    const responses = await Promise.all([
      limited.app.inject({ url: proxiedImage("https://image-processing.example/limited-app", "full")! }),
      ready.app.inject({ url: proxiedImage("https://image-processing.example/ready-app", "full")! }),
    ]);
    assert.deepEqual(responses.map(response => response.statusCode), [503, 200]);
    await limited.app.close();
    assert.equal((await ready.app.inject({ url: proxiedImage("https://image-processing.example/after-other-close", "full")! })).statusCode, 200);
  } finally { await limited.app.close(); await ready.app.close(); }
});
