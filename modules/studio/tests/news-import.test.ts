import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
async function auth() {
  config.adminPassword = "studio-import-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-import-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf as string };
}
const endpoint = "/api/admin/studio/news-sources/import";

const snapshot = { sources: [
  { id: "import-rss", name: "实际订阅新闻", kind: "rss", enabled: false, tags: ["影视", "教程"],
    config: { feedUrl: "https://news.example/feed?token=secret-fixture" }, tier: "T1", first_party: true,
    participation_mode: "hot_signal", signal_group_id: "creators", owner_entity_id: "publisher-fixture",
    interval_minutes: 90, site_fulltext: false, syndicate_fulltext: false, created_at: "2026-08-01T00:00:00Z",
    health: "ok", last_ok_at: "2026-10-16T00:00:00Z", cursor: { initializedAt: "2026-08-01" } },
  { id: "import-external", name: "已有外部桥接", kind: "external", enabled: true, tags: ["工具"], config: {} },
] };

test("导入来源需要登录和CSRF，不凭上传请求改变关注库", async () => {
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload: { sources: [] } })).statusCode, 401);
  const headers = await auth();
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers: { cookie: headers.cookie }, payload: { sources: [] } })).statusCode, 403);
});

test("实际来源快照保留身份配置分组启停，重复导入不覆盖后续用户修改", async () => {
  const headers = await auth();
  const run = () => app.inject({ method: "POST", url: endpoint, headers, payload: snapshot });
  const first = await run();
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { added: 2, skipped: 0 });
  assert.ok(!first.body.includes("secret-fixture"));
  const detail = (await app.inject({ url: "/api/admin/sources/import-rss", headers })).json().source;
  for (const key of ["id", "name", "kind", "enabled", "tags", "config", "tier", "first_party", "participation_mode", "signal_group_id", "owner_entity_id", "interval_minutes", "site_fulltext", "syndicate_fulltext"]) {
    assert.deepEqual(detail[key], (snapshot.sources[0] as Record<string, unknown>)[key], key);
  }
  assert.equal(detail.cursor, null, "old collection cursor must not skip missing material in this new database");
  assert.equal(detail.last_ok_at, null, "importing settings is not a successful local collection");
  const change = await app.inject({ method: "PATCH", url: "/api/admin/sources/import-rss", headers,
    payload: { version: detail.updated_at, patch: { name: "我的新名称", enabled: true } } });
  assert.equal(change.statusCode, 200);
  assert.deepEqual((await run()).json(), { added: 0, skipped: 2 });
  const cards = (await app.inject({ url: "/api/admin/studio/news-sources", headers })).json();
  assert.equal(cards.total, 2);
  const card = cards.rows.find((row: { id: string }) => row.id === "import-rss");
  assert.equal(card.name, "我的新名称");
  assert.equal(card.enabled, true);
  assert.deepEqual(card.tags, ["影视", "教程"]);
});

test("不同编号的同一采集地址也去重，并发重复导入只新增一次", async () => {
  const headers = await auth();
  const payload = { sources: ["alias-a", "alias-b"].map(id => ({ id, name: id, kind: "rss", config: { feedUrl: "https://alias.example/feed" } })) };
  const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: endpoint, headers, payload })));
  assert.ok(results.every(result => result.statusCode === 200));
  assert.deepEqual(results.map(result => result.json().added).sort(), [0, 1]);
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?q=alias-", headers })).json().total, 1);
});

test("坏记录令整批拒绝，错误响应不回显配置凭据", async () => {
  const headers = await auth();
  const result = await app.inject({ method: "POST", url: endpoint, headers, payload: { sources: [
    { id: "invalid-batch-good", name: "不可部分导入", kind: "rss", config: { feedUrl: "https://valid.example/feed" } },
    { id: "invalid-batch-bad", name: "坏配置", kind: "rss", config: { feedUrl: "secret-fixture" }, interval_minutes: -1 },
  ] } });
  assert.equal(result.statusCode, 400);
  assert.ok(!result.body.includes("secret-fixture"));
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?q=invalid-batch", headers })).json().total, 0);
});
