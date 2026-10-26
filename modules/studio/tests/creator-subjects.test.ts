import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";

const resources = await sourceResourceFixture(), { app } = resources;
await resources.warm();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
async function auth() {
  config.adminPassword = "creator-subject-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=creator-subject-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}
type Account = { id: string; version: number; subject: { id: string; name: string } | null };
test("手动确认同人跨平台关联，版本冲突整批回退，解除或移除关注不改变其他账号", async () => {
  const headers = await auth(), path = "/api/admin/studio/creator-subjects";
  assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  const accounts: Account[] = [];
  for (const url of ["https://space.bilibili.com/930000001", "https://www.douyin.com/user/same-person-douyin", "https://www.zhihu.com/people/another-person"]) {
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url } });
    assert.equal(created.statusCode, 200); accounts.push(created.json().creator);
  }
  const change = (rows: Account[], target: { name: string } | { subjectId: string | null }) => app.inject({ method: "POST", url: path, headers,
    payload: { accounts: rows.map(({ id, version }) => ({ id, version })), ...target } });
  assert.ok(accounts.every(row => row.subject === null));
  const linked = await change(accounts.slice(0, 2), { name: "镜头研究员" });
  assert.equal(linked.statusCode, 200, linked.body);
  const current: Account[] = accounts.slice(0, 2).map(account => linked.json().creators.find((row: Account) => row.id === account.id)), subject = current[0]!.subject!;
  assert.equal(subject.name, "镜头研究员"); assert.equal(current[1]!.subject!.id, subject.id);
  const read = async () => (await app.inject({ url: "/api/admin/studio/creators", headers })).json().rows as Account[];
  assert.equal((await read()).find(row => row.id === accounts[2]!.id)!.subject, null);
  assert.equal((await change([current[0]!, accounts[1]!], { subjectId: null })).statusCode, 409);
  assert.ok((await read()).filter(row => row.id !== accounts[2]!.id).every(row => row.subject?.id === subject.id && row.version === 2));
  assert.equal((await change([accounts[2]!], { subjectId: subject.id })).statusCode, 200);
  const unlinked = await change([current[0]!], { subjectId: null });
  assert.equal(unlinked.statusCode, 200); assert.equal(unlinked.json().creators[0].subject, null);
  const removed = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${current[1]!.id}/archive`, headers,
    payload: { version: current[1]!.version, archived: true } });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().creator.subject.id, subject.id);
  assert.equal((await read()).find(row => row.id === accounts[2]!.id)!.subject!.id, subject.id);
  const subjects = await app.inject({ url: path + "?q=" + encodeURIComponent("镜头"), headers });
  assert.equal(subjects.statusCode, 200); assert.equal(subjects.headers["cache-control"], "no-store");
  assert.equal(subjects.json().rows[0].id, subject.id); assert.equal(subjects.json().rows[0].accountCount, 2);
  const latest = unlinked.json().creators[0];
  assert.equal((await change([latest], { subjectId: "00000000-0000-0000-0000-000000000000" })).statusCode, 409);
  assert.equal((await change([latest, latest], { name: "不能重复" })).statusCode, 400);
  assert.equal((await change([latest], { name: " " })).statusCode, 400);
  assert.equal((await app.inject({ url: path })).statusCode, 401);
});

test("同人标识进入情报和两日冻结材料，解除关联不改写历史批次", async t => {
  const headers = await auth(), previous = getGlobalDispatcher(), transport = new MockAgent();
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); });
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(created.statusCode, 200); let account = created.json().creator;
  const linked = await app.inject({ method: "POST", url: "/api/admin/studio/creator-subjects", headers,
    payload: { accounts: [{ id: account.id, version: account.version }], name: "影视流程研究" } });
  assert.equal(linked.statusCode, 200); account = linked.json().creators[0];
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${account.id}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport, { replies: true });
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const row = (await app.inject({ url: "/api/admin/studio/intelligence?platform=bilibili", headers })).json().rows[0];
  assert.deepEqual(row.source.subject, account.subject);
  const detail = (await app.inject({ url: `/api/admin/studio/intelligence/${encodeURIComponent(row.id)}`, headers })).json();
  assert.deepEqual(detail.source.subject, account.subject);
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comments[1].parentExternalId, "99");
  assert.equal(detail.commentCoverage.replySample.count, 1);
  // Align the plan with the real ingestion date; only freeze time advances, not the database clock.
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  const start = new Date(Date.parse(row.collectedAt) - 3600_000).toISOString();
  const configured = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: plan.version, enabled: false, startsAt: start } });
  assert.equal(configured.statusCode, 200, configured.body);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(start) + 49 * 3600_000 });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  const readFrozen = () => app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers });
  const original = (await readFrozen()).json().rows.find((item: { id: string }) => item.id === row.id);
  assert.deepEqual(original.source.subject, account.subject);
  assert.deepEqual(original.comments, detail.comments);
  assert.deepEqual(original.commentCoverage, detail.commentCoverage);
  const current = (await app.inject({ url: "/api/admin/studio/creators?platform=bilibili&q=20813884", headers })).json().rows[0];
  const unlinked = await app.inject({ method: "POST", url: "/api/admin/studio/creator-subjects", headers,
    payload: { accounts: [{ id: current.id, version: current.version }], subjectId: null } });
  assert.equal(unlinked.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?platform=bilibili", headers })).json().rows[0].source.subject, undefined);
  assert.deepEqual((await readFrozen()).json().rows.find((item: { id: string }) => item.id === row.id), original);
  transport.assertNoPendingInterceptors();
});
