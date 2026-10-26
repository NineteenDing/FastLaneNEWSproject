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
async function authenticated() {
  config.adminPassword = "creator-following-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=creator-following-test-password" });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("粘贴B站完整主页登记关注，分享参数不产生重复账号且未取得的资料不伪造", async () => {
  const headers = await authenticated();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://space.bilibili.com/434377496?spm_id_from=private-tracking" } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.headers["cache-control"], "no-store");
  const first = created.json();
  assert.equal(first.created, true);
  assert.equal(first.creator.platform, "bilibili");
  assert.equal(first.creator.homepage, "https://space.bilibili.com/434377496");
  assert.equal(first.creator.name, null);
  assert.equal(first.creator.followerCount, null);
  assert.equal(first.creator.workCount, null);
  assert.equal(first.creator.profileState, "pending");
  const repeated = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://space.bilibili.com/434377496/" } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().created, false);
  assert.equal(repeated.json().creator.id, first.creator.id);
  const listing = await app.inject({ url: "/api/admin/studio/creators?q=434377496", headers });
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.json().total, 1);
  assert.equal(listing.json().rows[0].enabled, true);
  assert.ok(!listing.body.includes("private-tracking"));
});

test("其余六平台完整主页均可登记，平台身份独立，私有分享参数不出现在关注卡片", async () => {
  const headers = await authenticated();
  const examples = [
    ["xhs", "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae?xsec_token=private-xsec-fixture&xsec_source=pc_share", "5eb8e1d400000000010075ae"],
    ["douyin", "https://www.douyin.com/user/MS4wLjABAAAAexample?from_tab_name=main", "MS4wLjABAAAAexample"],
    ["kuaishou", "https://www.kuaishou.com/profile/3x84qugg4ch9zhs", "3x84qugg4ch9zhs"],
    ["weibo", "https://weibo.com/u/5756404150?from=private-tracking", "5756404150"],
    ["tieba", "https://tieba.baidu.com/home/main/?id=tb.1.7f139e2e.6CyEwxu3VJruH_-QqpCi6g&fr=frs", "tb.1.7f139e2e.6CyEwxu3VJruH_-QqpCi6g"],
    ["zhihu", "https://www.zhihu.com/people/yd1234567/answers", "yd1234567"],
  ];
  for (const [platform, url, locator] of examples) {
    const result = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url } });
    assert.equal(result.statusCode, 200, platform);
    assert.equal(result.json().creator.platform, platform);
    assert.equal(result.json().creator.locator, locator);
    assert.equal(result.json().creator.profileState, "pending");
    assert.equal(result.json().creator.collectionState, "not_connected");
    assert.ok(!result.body.includes("private-"));
  }
  const listing = await app.inject({ url: "/api/admin/studio/creators", headers });
  assert.equal(listing.json().total, 7);
  assert.ok(!listing.body.includes("private-xsec-fixture"));
  assert.ok(!listing.body.includes("collector_context"));
});

test("博主暂停、移除和恢复保留同一账号，旧窗口不能覆盖状态，筛选不会混入其他平台", async () => {
  const headers = await authenticated();
  const result = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  let account = result.json().creator;
  const paused = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${account.id}/status`, headers,
    payload: { version: account.version, enabled: false } });
  assert.equal(paused.statusCode, 200);
  const stale = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${account.id}/status`, headers,
    payload: { version: account.version, enabled: true } });
  assert.equal(stale.statusCode, 409);
  account = paused.json().creator;
  const pausedList = await app.inject({ url: "/api/admin/studio/creators?enabled=false&platform=bilibili&q=20813884", headers });
  assert.equal(pausedList.json().total, 1);
  const removed = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${account.id}/archive`, headers,
    payload: { version: account.version, archived: true } });
  assert.equal(removed.statusCode, 200);
  account = removed.json().creator;
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?q=20813884", headers })).json().total, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?archived=true&q=20813884", headers })).json().rows[0].id, account.id);
  const blocked = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${account.id}/status`, headers,
    payload: { version: account.version, enabled: true } });
  assert.equal(blocked.statusCode, 409);
  const restored = await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${account.id}/archive`, headers,
    payload: { version: account.version, archived: false } });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().creator.id, account.id);
  assert.equal(restored.json().creator.enabled, false);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?platform=xhs&q=20813884", headers })).json().total, 0);
});

test("关注接口沿用登录和CSRF，拒绝伪造域名/私网/作品链接，失败不产生关注记录", async () => {
  const headers = await authenticated();
  assert.equal((await app.inject({ url: "/api/admin/studio/creators" })).statusCode, 401);
  const missingCsrf = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers: { cookie: headers.cookie }, payload: { url: "https://space.bilibili.com/1" } });
  assert.equal(missingCsrf.statusCode, 403);
  const before = (await app.inject({ url: "/api/admin/studio/creators", headers })).json().total;
  for (const url of ["https://space.bilibili.com.evil.example/1", "http://127.0.0.1/user/example", "https://private:password@www.douyin.com/user/example",
    "https://www.douyin.com/video/12345", "file:///C:/secret", "https://tieba.baidu.com/home/main?id=tb.one&id=tb.two"]) {
    const rejected = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url } });
    assert.equal(rejected.statusCode, 400, url);
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, before);
  const duplicate = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/admin/studio/creators", headers,
    payload: { url: "https://www.kuaishou.com/profile/concurrent-account" } })));
  assert.ok(duplicate.every(result => result.statusCode === 200));
  assert.equal(duplicate.filter(result => result.json().created).length, 1);
  assert.equal(duplicate[0]!.json().creator.id, duplicate[1]!.json().creator.id);
});

test("批量暂停移除恢复逐项检查版本，任一旧版本或不存在账号使整批保持原状", async () => {
  const headers = await authenticated(), path = "/api/admin/studio/creators/batch";
  assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  const accounts = [];
  for (const uid of ["310000001", "310000002"]) accounts.push((await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: `https://space.bilibili.com/${uid}` } })).json().creator);
  const submit = (rows: { id: string; version: number }[], change: { enabled: boolean } | { archived: boolean }) => app.inject({ method: "POST", url: path, headers, payload: { accounts: rows.map(({ id, version }) => ({ id, version })), ...change } });
  const paused = await submit(accounts, { enabled: false }); assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().creators.length, 2); assert.ok(paused.json().creators.every((row: { enabled: boolean }) => !row.enabled));
  const current = accounts.map(account => paused.json().creators.find((row: { id: string }) => row.id === account.id));
  const stale = await submit([current[0], accounts[1]], { enabled: true }); assert.equal(stale.statusCode, 409);
  const list = (await app.inject({ url: "/api/admin/studio/creators?q=31000000", headers })).json();
  assert.ok(list.rows.every((row: { enabled: boolean; version: number }) => !row.enabled && row.version === 2));
  const removed = await submit(current, { archived: true }); assert.equal(removed.statusCode, 200);
  assert.ok(removed.json().creators.every((row: { archived: boolean }) => row.archived));
  const restored = await submit(removed.json().creators, { archived: false }); assert.equal(restored.statusCode, 200);
  assert.ok(restored.json().creators.every((row: { enabled: boolean; archived: boolean }) => !row.enabled && !row.archived));
  const latest = restored.json().creators;
  const missing = await submit([latest[0], { id: "00000000-0000-0000-0000-000000000000", version: 1 }], { enabled: true });
  assert.equal(missing.statusCode, 409);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?q=31000000", headers })).json().rows.filter((row: { enabled: boolean }) => row.enabled).length, 0);
  assert.equal((await submit([latest[0], latest[0]], { enabled: true })).statusCode, 400);
});
