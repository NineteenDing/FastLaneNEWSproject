import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { checkMpAccount } from "@aihot/backend/sources/mp";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
const previous = getGlobalDispatcher();
const transport = new MockAgent();
transport.disableNetConnect();
setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
after(async () => {
  setGlobalDispatcher(previous);
  await transport.close(); await app.close(); await stopBoss(); await closeDb();
});

async function session() {
  config.adminPassword = "studio-archive-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "username=admin&password=studio-archive-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("移除来源后退出当前关注并停止后续采集，恢复沿用原身份、资料和历史材料", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "archive-news", name: "可恢复的来源", kind: "rss",
      config: { feedUrl: "https://archive.example/feed?token=private-fixture", fetchPublicContent: false } } });
  assert.equal(created.statusCode, 200);
  const profile = await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/archive-news/profile", headers,
    payload: { version: 0, description: "保存的资料", region: "中国", language: null, homepage: null } });
  assert.equal(profile.statusCode, 200);
  transport.get("https://archive.example").intercept({ path: "/feed?token=private-fixture" })
    .reply(200, `<rss version="2.0"><channel><title>来源</title><item><title>镜头控制更新</title>
      <link>https://archive.example/story</link><description>参数说明</description>
      <pubDate>${new Date(Date.now() - 60000).toUTCString()}</pubDate></item></channel></rss>`);
  assert.equal((await collectSource("archive-news")).created, 1);
  const read = async (removed = false) => {
    const response = await app.inject({ url: `/api/admin/studio/news-sources?q=archive-news${removed ? "&archived=true" : ""}`, headers });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const before = (await read()).rows[0];
  assert.equal(before.collectedCount, 1);
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/archive-news/archive", headers,
    payload: { version: before.version, archived: true } });
  assert.equal(changed.statusCode, 200);
  assert.ok(!changed.body.includes("private-fixture"));
  assert.equal((await read()).total, 0);
  const removed = (await read(true)).rows[0];
  assert.equal(removed.archived, true);
  assert.equal(removed.enabled, false);
  assert.equal(removed.collectedCount, 1);
  assert.equal((await collectSource("archive-news")).status, "skipped");
  const restored = await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/archive-news/archive", headers,
    payload: { version: removed.version, archived: false } });
  assert.equal(restored.statusCode, 200);
  const next = (await read()).rows[0];
  assert.equal(next.id, before.id);
  assert.equal(next.addedAt, before.addedAt);
  assert.equal(next.description, "保存的资料");
  assert.equal(next.collectedCount, 1);
  assert.equal(next.enabled, false, "恢复后先暂停，明确启用才开始下一次采集");
  assert.equal((await read(true)).total, 0);
});

test("已移除来源不会被旧窗口启用或强制采集任务重新启动", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "guarded-news", name: "移除保护", kind: "rss", config: { feedUrl: "https://archive.example/guarded" } } });
  assert.equal(created.statusCode, 200);
  const archive = await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/guarded-news/archive", headers,
    payload: { version: created.json().source.updated_at, archived: true } });
  assert.equal(archive.statusCode, 200);
  assert.equal((await collectSource("guarded-news", { force: true })).status, "skipped");
  const removed = (await app.inject({ url: "/api/admin/studio/news-sources?q=guarded-news&archived=true", headers })).json().rows[0];
  for (const [url, payload] of [
    ["/api/admin/studio/news-sources/guarded-news/status", { version: removed.version, enabled: true }],
    ["/api/admin/sources/guarded-news", { version: removed.version, patch: { enabled: true } }],
  ] as const) {
    assert.equal((await app.inject({ method: "PATCH", url, headers, payload })).statusCode, 409);
  }
});

test("移除和恢复需登录、CSRF和当前版本，已移除来源不能提交立即采集", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "protected-news", name: "操作保护", kind: "rss", config: { feedUrl: "https://archive.example/protected" } } });
  assert.equal(created.statusCode, 200);
  const url = "/api/admin/studio/news-sources/protected-news/archive";
  const payload = { version: created.json().source.updated_at, archived: true };
  assert.equal((await app.inject({ method: "PATCH", url, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { ...payload, archived: "true" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: url.replace("protected-news", "not-found"), headers, payload })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { ...payload, archived: false } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources/protected-news/fetch", headers })).statusCode, 409);
});

test("移除前已排队的公众号手动检查在执行时跳过已移除来源", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "archived-mp", name: "移除的公众号", kind: "mp_account", config: { ghid: "gh_archived_fixture" } } });
  assert.equal(created.statusCode, 200);
  const removed = await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/archived-mp/archive", headers,
    payload: { version: created.json().source.updated_at, archived: true } });
  assert.equal(removed.statusCode, 200);
  assert.equal((await checkMpAccount("archived-mp", "manual")).status, "archived");
});

test("从旧编辑接口恢复来源也先保持暂停，随后才能单独启用", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "legacy-restore", name: "旧入口恢复", kind: "rss", config: { feedUrl: "https://archive.example/legacy" } } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/legacy-restore/archive", headers,
    payload: { version: created.json().source.updated_at, archived: true } })).statusCode, 200);
  const removed = (await app.inject({ url: "/api/admin/studio/news-sources?q=legacy-restore&archived=true", headers })).json().rows[0];
  const restored = await app.inject({ method: "PATCH", url: "/api/admin/sources/legacy-restore", headers,
    payload: { version: removed.version, patch: { archived: false, enabled: true } } });
  assert.equal(restored.statusCode, 200);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=legacy-restore", headers })).json().rows[0];
  assert.equal(card.enabled, false);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/legacy-restore/status", headers,
    payload: { version: card.version, enabled: true } })).statusCode, 200);
});
