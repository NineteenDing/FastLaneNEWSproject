import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import sharp from "sharp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { createImageAssets } from "../backend/image-assets.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
async function collect(id: string) {
  const submit = await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} });
  assert.equal(submit.statusCode, 200);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
}
const read = async () => (await app.inject({ url: "/api/admin/studio/creators", headers })).json().rows[0];

test("博主公开头像随采集保存到本地，情报与冻结快照保留版本，换头像或取消关注不改旧图片", async t => {
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(added.statusCode, 200);
  const id = added.json().creator.id;
  const png = await sharp({ create: { width: 96, height: 96, channels: 4, background: "#276955" } }).png().toBuffer();
  bilibiliFixture(transport, { avatar: "https://i0.hdslb.com/avatar-fixture.png" });
  transport.get("https://i0.hdslb.com").intercept({ path: "/avatar-fixture.png" }).reply(200, png, { headers: { "content-type": "image/png" } });
  await collect(id);
  const card = await read(); assert.equal(card.name, "影视流程研究");
  assert.equal(card.avatarUrl.split("?")[0], `/api/admin/studio/creators/${id}/avatar`);
  assert.match(new URL(card.avatarUrl, "http://127.0.0.1").searchParams.get("v")!, /^[a-f0-9]{64}$/);
  assert.equal((await app.inject({ url: card.avatarUrl })).statusCode, 401);
  const image = await app.inject({ url: card.avatarUrl, headers });
  assert.equal(image.statusCode, 200); assert.equal(image.headers["cache-control"], "no-store");
  assert.match(String(image.headers["content-type"]), /^image\//);
  assert.equal((await sharp(image.rawPayload).metadata()).width, 96);
  // Reproduce an installed pre-versioning account through the existing asset-reference interface.
  await createImageAssets().setReferences(`creator-avatar:${id}:${new URL(card.avatarUrl, "http://127.0.0.1").searchParams.get("v")}`, []);
  const intelligence = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows[0];
  assert.equal(intelligence.source.avatarUrl, card.avatarUrl);
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: 0, enabled: false, startsAt: window.startsAt } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(window.endsAt) });
  await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: window.startsAt } });
  assert.equal(frozen.statusCode, 200);
  const snapshot = () => app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers });
  assert.equal((await snapshot()).json().rows[0].source.avatarUrl, card.avatarUrl);
  t.mock.timers.reset();
  const changedPng = await sharp({ create: { width: 96, height: 96, channels: 4, background: "#b84a21" } }).png().toBuffer();
  bilibiliFixture(transport, { avatar: "https://i0.hdslb.com/new-avatar.png" });
  transport.get("https://i0.hdslb.com").intercept({ path: "/new-avatar.png" }).reply(200, changedPng, { headers: { "content-type": "image/png" } });
  await collect(id);
  const updated = await read(); assert.notEqual(updated.avatarUrl, card.avatarUrl);
  assert.notDeepEqual((await app.inject({ url: updated.avatarUrl, headers })).rawPayload, image.rawPayload);
  await createImageAssets().prune(new Date(Date.now() + 32 * 86400000));
  assert.equal((await snapshot()).json().rows[0].source.avatarUrl, card.avatarUrl);
  assert.deepEqual((await app.inject({ url: card.avatarUrl, headers })).rawPayload, image.rawPayload);
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${id}/avatar?v=${"0".repeat(64)}`, headers })).statusCode, 404);
  const archived = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${id}/archive`, headers, payload: { version: updated.version, archived: true } });
  assert.equal(archived.statusCode, 200); assert.equal((await app.inject({ url: card.avatarUrl, headers })).statusCode, 200);
  transport.assertNoPendingInterceptors();
});

test("头像临时失败保留原图且正文照常更新，头像下载期间暂停也不发布迟到的资料", async () => {
  const archived = (await app.inject({ url: "/api/admin/studio/creators?archived=true", headers })).json().rows[0];
  const restored = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${archived.id}/archive`, headers, payload: { version: archived.version, archived: false } });
  await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${archived.id}/status`, headers, payload: { version: restored.json().creator.version, enabled: true } });
  const before = await read(), original = (await app.inject({ url: before.avatarUrl, headers })).rawPayload;
  bilibiliFixture(transport, { avatar: "https://i0.hdslb.com/temporarily-missing.png", views: 22000 });
  transport.get("https://i0.hdslb.com").intercept({ path: "/temporarily-missing.png" }).reply(503, "unavailable");
  await collect(before.id);
  let card = await read(); assert.equal(card.collectionState, "ready");
  assert.deepEqual((await app.inject({ url: card.avatarUrl, headers })).rawPayload, original);
  const posts = (await app.inject({ url: `/api/admin/studio/creators/${card.id}/contents`, headers })).json();
  assert.equal(posts.rows[0].metrics.views, 22000);
  let started!: () => void; const downloading = new Promise<void>(resolve => { started = resolve; });
  const png = await sharp({ create: { width: 96, height: 96, channels: 4, background: "#b84a21" } }).png().toBuffer();
  bilibiliFixture(transport, { avatar: "https://i0.hdslb.com/late-avatar.png", views: 33000 });
  transport.get("https://i0.hdslb.com").intercept({ path: "/late-avatar.png" }).reply(() => {
    started(); return { statusCode: 200, data: png, responseOptions: { headers: { "content-type": "image/png" } } };
  }).delay(250);
  const pending = collect(card.id); await downloading;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${card.id}/status`, headers, payload: { version: card.version, enabled: false } })).statusCode, 200);
  await pending; card = await read();
  assert.equal(card.collectionState, "interrupted");
  assert.deepEqual((await app.inject({ url: card.avatarUrl, headers })).rawPayload, original);
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${card.id}/contents`, headers })).json().rows[0].metrics.views, 22000);
  transport.assertNoPendingInterceptors();
});
