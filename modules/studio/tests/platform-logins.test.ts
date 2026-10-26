import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { claimExecutionLease, releaseExecutionLease } from "@aihot/backend/jobs/execution-lease";
import { config } from "@aihot/backend/config";
import { createServer } from "node:http";
import { openPlatformLogin } from "../backend/platform-login-browser.ts";

let cookie = "", closes = 0, openingFails = false;
const originalCollect = process.env.COLLECT_ENABLED;
process.env.COLLECT_ENABLED = "false";
const actions: unknown[] = [];
const fixture = await sourceResourceFixture({ loginBrowser: async () => { if (openingFails) throw new Error("unconfirmed browser shutdown"); return {
  frame: async () => Buffer.from([255, 216, 255, 217]),
  session: async () => cookie,
  action: async (value: unknown) => { actions.push(value); },
  close: async () => { closes++; },
}; } });
await fixture.warm();
const { app, headers } = fixture;
after(async () => { await app.close(); await stopBoss(); await closeDb(); if (originalCollect === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = originalCollect; });
const base = "/api/admin/studio/platform-logins";

test("网页受控平台登录取得会话后自动加密保存，不回显Cookie、不擅自开启采集", async () => {
  assert.equal((await app.inject({ method: "POST", url: base, payload: { platform: "xhs", version: 0 } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: base, headers: { cookie: headers.cookie }, payload: { platform: "xhs", version: 0 } })).statusCode, 403);
  const start = await app.inject({ method: "POST", url: base, headers, payload: { platform: "xhs", version: 0 } });
  assert.equal(start.statusCode, 200); assert.equal(start.json().state, "waiting");
  const id = start.json().id;
  const frame = await app.inject({ url: `${base}/${id}/frame`, headers });
  assert.equal(frame.statusCode, 200); assert.equal(frame.headers["content-type"], "image/jpeg");
  assert.equal(frame.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "POST", url: `${base}/${id}/actions`, headers, payload: { type: "click", x: 20, y: 30 } })).statusCode, 200);
  assert.deepEqual(actions, [{ type: "click", x: 20, y: 30 }]);
  cookie = "web_session=private-login-browser-cookie; a1=private-login-device";
  let result = start;
  for (let n = 0; n < 40; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await app.inject({ url: `${base}/${id}`, headers });
    if (result.json().state === "saved") break;
  }
  assert.equal(result.json().state, "saved"); assert.equal(result.json().collection, "paused");
  assert.ok(!result.body.includes("private-login")); assert.equal(closes, 1);
  const sessions = await app.inject({ url: "/api/admin/studio/platform-sessions", headers });
  assert.equal(sessions.json().rows.find((row: { platform: string }) => row.platform === "xhs").version, 1);
  assert.ok(!sessions.body.includes("private-login"));
  assert.equal((await app.inject({ url: `${base}/${id}/frame`, headers })).statusCode, 409);
});

test("重复窗口、采集转写执行位、取消和旧会话冲突均不覆盖其他平台信息", async () => {
  cookie = "";
  const occupied = "03d2b346-ae6f-4920-a600-1a8a4af305c1";
  assert.equal(await claimExecutionLease("studio-creator-media", occupied, 30), true);
  try {
    assert.equal((await app.inject({ method: "POST", url: base, headers, payload: { platform: "bilibili", version: 0 } })).statusCode, 409);
  } finally { await releaseExecutionLease("studio-creator-media", occupied); }
  const start = await app.inject({ method: "POST", url: base, headers, payload: { platform: "bilibili", version: 0 } });
  assert.equal(start.statusCode, 200); const id = start.json().id;
  assert.equal((await app.inject({ method: "POST", url: base, headers, payload: { platform: "weibo", version: 0 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `${base}/${id}/actions`, headers, payload: { type: "click", x: 901, y: 30 } })).statusCode, 400);
  assert.equal((await app.inject({ url: `${base}/${id}/frame` })).statusCode, 401);
  assert.equal((await app.inject({ method: "DELETE", url: `${base}/${id}`, headers })).json().state, "cancelled");
  const second = await app.inject({ method: "POST", url: base, headers, payload: { platform: "bilibili", version: 0 } });
  assert.equal(second.statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/bilibili", headers, payload: { version: 0, cookie: "SESSDATA=private-newer-manual" } })).statusCode, 200);
  cookie = "SESSDATA=private-stale-login";
  let status;
  for (let n = 0; n < 40; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await app.inject({ url: `${base}/${second.json().id}`, headers });
    if (status.json().state !== "waiting") break;
  }
  assert.equal(status!.json().state, "conflict"); assert.ok(!status!.body.includes("private-"));
  const rows = (await app.inject({ url: "/api/admin/studio/platform-sessions", headers })).json().rows;
  assert.equal(rows.find((r: { platform: string }) => r.platform === "bilibili").version, 1);
  assert.equal(rows.find((r: { platform: string }) => r.platform === "weibo").state, "missing");
});

test("实际无头浏览器可在受控本地页面显示、点击、输入及取消；匿名页面不冒充登录成功", async () => {
  const requests: string[] = [], server = createServer((req, res) => {
    requests.push(req.url!); res.setHeader("content-type", "text/html");
    res.setHeader("set-cookie", ["web_session=anonymous; Path=/", "a1=device; Path=/"]);
    res.end('<html><body><input id="name" style="position:absolute;left:10px;top:10px;width:200px;height:35px"><button style="position:absolute;left:10px;top:70px" onclick="fetch(`/clicked?text=${document.querySelector(`#name`).value}`)">登录</button></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const old = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const controller = new AbortController();
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const browser = await openPlatformLogin("xhs", controller.signal, `http://127.0.0.1:${address.port}/`);
    try {
      const frame = await browser.frame(); assert.ok(frame.length > 1000); assert.equal(frame[0], 255);
      assert.equal(await browser.session(), "");
      await browser.action({ type: "click", x: 40, y: 25 }); await browser.action({ type: "text", text: "local-login-test" });
      await browser.action({ type: "click", x: 30, y: 80 });
      for (let n = 0; n < 30 && !requests.some(url => url.includes("/clicked")); n++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(requests.includes("/clicked?text=local-login-test"));
      controller.abort();
    } finally { await browser.close(); }
  } finally { config.allowPrivateNetworkFetch = old; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("浏览器启动失败且无法确认退出时不提前归还共享执行位", async () => {
  openingFails = true;
  assert.equal((await app.inject({ method: "POST", url: base, headers, payload: { platform: "weibo", version: 0 } })).statusCode, 409);
  const token = "eb5a8488-5ecb-4bcc-946f-c6800cb13099";
  const claimed = await claimExecutionLease("studio-creator-media", token, 30);
  if (claimed) await releaseExecutionLease("studio-creator-media", token);
  assert.equal(claimed, false);
});
