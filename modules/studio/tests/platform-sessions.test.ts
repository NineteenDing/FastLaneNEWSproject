import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
async function auth() {
  config.adminPassword = "platform-session-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=platform-session-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { cookie, "x-csrf-token": (await app.inject({ url: "/api/admin/me", headers: { cookie } })).json().csrf };
}

test("七平台会话可私有保存但不可回读Cookie，版本冲突保护，清除后保留版本", async () => {
  const headers = await auth();
  const initial = await app.inject({ url: "/api/admin/studio/platform-sessions", headers });
  assert.equal(initial.statusCode, 200); assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().rows.length, 7);
  const save = await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers, payload: { version: 0, cookie: "a1=private-cookie-fixture; web_session=private-session-fixture" } });
  assert.equal(save.statusCode, 200); assert.equal(save.json().session.state, "saved");
  assert.equal(save.json().session.verified, false, "保存会话不等于平台登录已验证");
  const listing = await app.inject({ url: "/api/admin/studio/platform-sessions", headers });
  assert.ok(!listing.body.includes("private-")); assert.ok(!save.body.includes("private-"));
  assert.equal(listing.json().rows.find((p: { platform: string }) => p.platform === "xhs").version, 1);
  const stale = await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers, payload: { version: 0, cookie: "a1=old-window" } });
  assert.equal(stale.statusCode, 409);
  const removed = await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers, payload: { version: 1, cookie: "" } });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().session.state, "missing"); assert.equal(removed.json().session.version, 2);
  assert.equal((await app.inject({ url: "/api/admin/studio/platform-sessions" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/xhs", headers: { cookie: headers.cookie }, payload: { version: 2, cookie: "a1=forbidden" } })).statusCode, 403);
});

test("首次并发保存只有一个成功，拒绝请求头注入，服务器密钥改变时明确要求重新保存", async () => {
  const headers = await auth();
  const attempts = await Promise.all(["one", "two"].map(value => app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers,
    payload: { version: 0, cookie: `SUB=private-${value}` } })));
  assert.deepEqual(attempts.map(r => r.statusCode).sort(), [200, 409]);
  for (const cookie of ["SUB=value\r\nHost:evil.example", "Cookie: SUB=wrong", "not-a-cookie", "a1=非请求头字符"]) {
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/weibo", headers, payload: { version: 1, cookie } })).statusCode, 400);
  }
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "another-server-secret-for-rotation-test";
  try {
    const changedHeaders = await auth();
    const rows = (await app.inject({ url: "/api/admin/studio/platform-sessions", headers: changedHeaders })).json().rows;
    assert.equal(rows.find((p: { platform: string }) => p.platform === "weibo").state, "unreadable");
    assert.ok(!JSON.stringify(rows).includes("private-"));
  } finally { process.env.SESSION_SECRET = old; }
});
