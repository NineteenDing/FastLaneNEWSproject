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

async function session() {
  config.adminPassword = "studio-profile-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "username=admin&password=studio-profile-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("编辑新闻资料后卡片保留简介地区语言和主页；旧窗口不能覆盖更新", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "profile-news", name: "影视日报", kind: "rss", config: { feedUrl: "https://example.com/rss?token=private-fixture" } } });
  assert.equal(created.statusCode, 200);
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=profile-news", headers })).json().rows[0];
  const first = await read();
  const payload = { version: first.profileVersion ?? 0, description: "影视制作与工具新闻", region: "中国", language: "简体中文", homepage: "https://example.com/news" };
  const saved = await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/profile-news/profile", headers, payload });
  assert.equal(saved.statusCode, 200);
  const next = await read();
  assert.equal(next.description, "影视制作与工具新闻");
  assert.equal(next.region, "中国");
  assert.equal(next.language, "简体中文");
  assert.equal(next.homepage, "https://example.com/news");
  assert.equal(next.profileVersion, 1);
  assert.ok(!saved.body.includes("private-fixture"));
  const stale = await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/profile-news/profile", headers,
    payload: { ...payload, description: "另一个窗口的旧修改" } });
  assert.equal(stale.statusCode, 409);
  assert.equal((await read()).description, "影视制作与工具新闻");
});

test("资料写入需登录与CSRF，拒绝脚本或带凭据主页，允许清空资料", async () => {
  const headers = await session();
  const url = "/api/admin/studio/news-sources/profile-news/profile";
  const payload = { version: 1, description: null, region: null, language: null, homepage: null };
  assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  for (const homepage of ["javascript:alert(1)", "https://user:secret@example.com", "https://example.com/?token=secret", "not-a-url"]) {
    const rejected = await app.inject({ method: "PUT", url, headers, payload: { ...payload, homepage } });
    assert.equal(rejected.statusCode, 400);
    assert.ok(!rejected.body.includes("secret"));
  }
  assert.equal((await app.inject({ method: "PUT", url: url.replace("profile-news", "unknown-news"), headers, payload })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 200);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=profile-news", headers })).json().rows[0];
  assert.equal(card.homepage, null);
  assert.equal(card.description, null);
});

test("关注页可以暂停和恢复来源，复用来源版本保护且不返回采集凭据", async () => {
  const headers = await session();
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=profile-news", headers })).json().rows[0];
  const before = await read();
  const url = "/api/admin/studio/news-sources/profile-news/status";
  assert.equal((await app.inject({ method: "PATCH", url, headers: { cookie: headers.cookie }, payload: { version: before.version, enabled: false } })).statusCode, 403);
  const pause = await app.inject({ method: "PATCH", url, headers, payload: { version: before.version, enabled: false } });
  assert.equal(pause.statusCode, 200);
  assert.ok(!pause.body.includes("private-fixture"));
  assert.ok(!pause.body.includes('"config"'));
  const paused = await read();
  assert.equal(paused.enabled, false);
  assert.equal(paused.health, "paused");
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: before.version, enabled: true } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: paused.version, enabled: true } })).statusCode, 200);
  assert.equal((await read()).enabled, true);
  assert.equal((await read()).lastCheckedAt, null);
});
