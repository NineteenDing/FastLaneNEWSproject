import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app } = resources;
await resources.warm();
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("实际采集入口收录的博主材料冻结简介、指标、评论范围和观察记录，取消关注不改写快照", async t => {
  config.adminPassword = "topic-batch-creator-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=topic-batch-creator-password" });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, "x-csrf-token": (await app.inject({ url: "/api/admin/me", headers: { cookie } })).json().csrf };
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(created.statusCode, 200); const creator = created.json().creator;
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: false, startsAt: window.startsAt } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.creator.collect")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const actual = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows[0];
  assert.ok(actual.collectedAt >= window.startsAt && actual.collectedAt < window.endsAt);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(window.endsAt) });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: window.startsAt } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 1);
  const read = () => app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers });
  const snapshot = (await read()).json().rows[0];
  assert.equal(snapshot.id, actual.id); assert.equal(snapshot.body, "先锁定参考，再组织镜头");
  assert.equal(snapshot.bodyState, "not_transcribed"); assert.equal(snapshot.analysisState, "not_connected");
  assert.equal(snapshot.source.name, "影视流程研究"); assert.equal(snapshot.metrics.views, 12000);
  assert.equal(snapshot.observations.length, 1); assert.equal(snapshot.observations[0].metrics.views, 12000);
  assert.equal(snapshot.comments[0].text, "换镜头后怎么维持角色？"); assert.equal(snapshot.commentCoverage.complete, false);
  assert.equal(snapshot.contentVersion.revision, null); assert.match(snapshot.contentVersion.fingerprint, /^[0-9a-f]{64}$/);
  const currentCreator = (await app.inject({ url: "/api/admin/studio/creators", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${creator.id}/archive`, headers,
    payload: { version: currentCreator.version, archived: true } })).statusCode, 200);
  assert.deepEqual((await read()).json().rows[0], snapshot);
  transport.assertNoPendingInterceptors();
});
