import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { zhihuFixture } from "./mediacrawler-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("知乎主页更名后按平台用户ID沿用原关注与作品，新旧链接不重复关注且历史快照不改写", async t => {
  await resources.warm();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/zhihu", headers,
    payload: { version: 0, cookie: "d_c0=private-zhihu-device; z_c0=private-zhihu-login" } })).statusCode, 200);
  const follow = (locator: string) => app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: `https://www.zhihu.com/people/${locator}` } });
  const first = (await follow("film-creator")).json().creator;
  const boss = await getBoss(), queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  async function collect(id: string, locator: string, body?: string) {
    zhihuFixture(transport, { locator, body, answersComplete: true });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  }
  await collect(first.id, "film-creator");
  const initial = (await app.inject({ url: `/api/admin/studio/creators/${first.id}/contents`, headers })).json(); assert.equal(initial.total, 2);
  const intelligence = (await app.inject({ url: "/api/admin/studio/intelligence?platform=zhihu", headers })).json();
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  const start = new Date(Date.parse(intelligence.rows[0].collectedAt) - 3600_000).toISOString();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: plan.version, enabled: false, startsAt: start } })).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(start) + 49 * 3600_000 });
  const batch = (await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start } })).json().batch;
  const frozen = (await app.inject({ url: `/api/admin/studio/topic-batches/${batch.id}/materials`, headers })).json();
  const second = (await follow("film-workflow-new")).json().creator;
  const linked = await app.inject({ method: "POST", url: "/api/admin/studio/creator-subjects", headers,
    payload: { accounts: [{ id: second.id, version: second.version }], name: "镜头创作研究员" } });
  assert.equal(linked.statusCode, 200); const subject = linked.json().creators[0].subject;
  await collect(second.id, "film-workflow-new", "<p>更新后仍先锁定角色参考，再核对镜头。</p>");
  const accounts = (await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers })).json();
  assert.equal(accounts.total, 1); assert.equal(accounts.rows[0].id, first.id);
  assert.equal(accounts.rows[0].homepage, "https://www.zhihu.com/people/film-workflow-new");
  assert.equal(accounts.rows[0].identity.stableId, "creator-stable-id");
  assert.deepEqual(accounts.rows[0].subject, subject);
  assert.equal((await app.inject({ url: "/api/admin/studio/creator-subjects", headers })).json().rows[0].accountCount, 1);
  assert.deepEqual(accounts.rows[0].identity.aliases.sort(), ["film-creator", "film-workflow-new"]);
  const contents = (await app.inject({ url: `/api/admin/studio/creators/${first.id}/contents`, headers })).json();
  assert.equal(contents.total, 2); assert.deepEqual(contents.rows.map((row: { id: string }) => row.id).sort(), initial.rows.map((row: { id: string }) => row.id).sort());
  assert.equal(contents.rows.find((row: { kind: string }) => row.kind === "answer").text, "更新后仍先锁定角色参考，再核对镜头。");
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?platform=zhihu", headers })).json().total, 2);
  for (const locator of ["film-creator", "film-workflow-new"]) {
    const repeated = await follow(locator); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().created, false); assert.equal(repeated.json().creator.id, first.id);
  }
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.id}/materials`, headers })).json(), frozen);
  await collect(first.id, "film-workflow-new");
  assert.equal((await app.inject({ url: `/api/admin/studio/creators/${first.id}/contents`, headers })).json().total, 2);
  transport.assertNoPendingInterceptors();
});

test("单条原文发现同一知乎作者的新主页时复用原关注，不产生第二个账号", async () => {
  const original = (await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers })).json().rows[0];
  const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers,
    payload: { url: "https://zhuanlan.zhihu.com/p/99901" } });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const entities = { users: { "creator-stable-id": { id: "creator-stable-id", urlToken: "film-workflow-latest", name: "影视创作实验室" } },
    articles: { "99901": { id: 99901, type: "article", author: "creator-stable-id", title: "把镜头检查放进流程", content: "<p>每个镜头生成后先检查角色特征。</p>", commentCount: 0 } } };
  transport.get("https://zhuanlan.zhihu.com").intercept({ path: "/p/99901" }).reply(200,
    `<script id="js-initialData">${JSON.stringify({ initialState: { entities } })}</script>`);
  const boss = await getBoss(), queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.content.import")!;
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const followed = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.zhihu.com/people/film-workflow-latest" } });
  assert.equal(followed.statusCode, 200); assert.equal(followed.json().creator.id, original.id);
  assert.equal(followed.json().created, false);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers })).json().total, 1);
  const contents = (await app.inject({ url: `/api/admin/studio/creators/${original.id}/contents`, headers })).json();
  assert.equal(contents.total, 3); assert.ok(contents.rows.some((row: { text: string }) => row.text === "每个镜头生成后先检查角色特征。"));
  transport.assertNoPendingInterceptors();
});

test("已确认账号的平台身份变化拒绝覆盖，别名采集也不绕过原账号暂停", async () => {
  const read = async () => (await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers })).json().rows[0];
  const original = await read();
  const before = (await app.inject({ url: `/api/admin/studio/creators/${original.id}/contents`, headers })).json();
  const boss = await getBoss(), queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!;
  async function collect(id: string) {
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(queue.name); assert.ok(job); return job;
  }
  zhihuFixture(transport, { locator: "film-workflow-latest", stableId: "different-platform-user", answersComplete: true, zeroComments: true });
  const wrong = await collect(original.id);
  await assert.rejects(queue.run([wrong.data] as never[]), /博主采集未完成/); await boss.fail(queue.name, wrong.id);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/creators/${original.id}/contents`, headers })).json(), before);
  const current = await read();
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${original.id}/status`, headers,
    payload: { version: current.version, enabled: false } })).statusCode, 200);
  const alias = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.zhihu.com/people/film-workflow-paused-alias" } })).json().creator;
  zhihuFixture(transport, { locator: "film-workflow-paused-alias", answersComplete: true, zeroComments: true, body: "<p>暂停后不应覆盖的内容。</p>" });
  const late = await collect(alias.id); await queue.run([late.data] as never[]); await boss.complete(queue.name, late.id);
  assert.equal((await read()).id, original.id); assert.equal((await read()).enabled, false);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?platform=zhihu", headers })).json().total, 1);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/creators/${original.id}/contents`, headers })).json(), before);
  const repeated = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.zhihu.com/people/film-workflow-paused-alias" } });
  assert.equal(repeated.json().creator.enabled, false); assert.equal(repeated.json().created, false);
  transport.assertNoPendingInterceptors();
});
