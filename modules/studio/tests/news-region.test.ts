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
  config.adminPassword = "studio-region-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-region-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("按已填写的服务地区筛选及分页，地区选项来自完整结果而非当前页，未知资料单独可查", async () => {
  const headers = await session();
  for (const [id, region] of [["cn-one", "中国"], ["cn-two", "中国"], ["us-one", "美国"], ["unknown", null]] as const) {
    const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name: "地区测试 " + id, kind: "rss", config: { feedUrl: `https://region.example/${id}` } } });
    assert.equal(source.statusCode, 200);
    if (region) assert.equal((await app.inject({ method: "PUT", url: `/api/admin/studio/news-sources/${id}/profile`, headers,
      payload: { version: 0, description: null, region, language: null, homepage: null } })).statusCode, 200);
  }
  const read = async (query: string) => {
    const result = await app.inject({ url: "/api/admin/studio/news-sources?" + query, headers });
    assert.equal(result.statusCode, 200);
    return result.json();
  };
  const first = await read(new URLSearchParams({ region: "中国", limit: "1" }).toString());
  assert.equal(first.total, 2);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].region, "中国");
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.regionOptions, [{ region: "中国", count: 2 }, { region: "美国", count: 1 }, { region: null, count: 1 }]);
  const second = await read(new URLSearchParams({ region: "中国", limit: "1", page: "2" }).toString());
  assert.equal(second.hasMore, false);
  assert.notEqual(second.rows[0].id, first.rows[0].id);
  const unknown = await read("regionMissing=true");
  assert.equal(unknown.total, 1);
  assert.equal(unknown.rows[0].id, "unknown");
  assert.equal((await read("region=" + encodeURIComponent("不存在的地区"))).total, 0);
});

test("地区与名称状态移除范围组合，统计只涵盖该范围，特殊字符按完整地区匹配", async () => {
  const headers = await session();
  for (const [id, region, enabled, archived] of [
    ["region-enabled", "全球_%", true, false], ["region-paused", "美国", false, false],
    ["region-removed", "全球_%", false, true],
  ] as const) {
    const result = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name: "组合地区 " + id, kind: "rss", enabled, config: { feedUrl: `https://region.example/${id}` } } });
    assert.equal(result.statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `/api/admin/studio/news-sources/${id}/profile`, headers,
      payload: { version: 0, region, description: null, language: null, homepage: null } })).statusCode, 200);
    if (archived) assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${id}/archive`, headers,
      payload: { version: result.json().source.updated_at, archived: true } })).statusCode, 200);
  }
  const read = async (query: Record<string, string>) => {
    const result = await app.inject({ url: "/api/admin/studio/news-sources?" + new URLSearchParams({ q: "组合地区", ...query }), headers });
    assert.equal(result.statusCode, 200);
    return result.json();
  };
  const active = await read({ enabled: "true", region: "全球_%" });
  assert.equal(active.total, 1);
  assert.equal(active.rows[0].id, "region-enabled");
  assert.deepEqual(active.regionOptions, [{ region: "全球_%", count: 1 }]);
  assert.equal((await read({ region: "%" })).total, 0);
  const paused = await read({ enabled: "false" });
  assert.deepEqual(paused.regionOptions, [{ region: "美国", count: 1 }]);
  const removed = await read({ archived: "true", region: "全球_%" });
  assert.equal(removed.rows[0].id, "region-removed");
  assert.deepEqual(removed.regionOptions, [{ region: "全球_%", count: 1 }]);
  const invalidQueries: Array<Record<string, string>> = [{ region: "中国", regionMissing: "true" }, { regionMissing: "false" }, { region: "x".repeat(81) }];
  for (const query of invalidQueries) {
    assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?" + new URLSearchParams(query), headers })).statusCode, 400);
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources?regionMissing=true" })).statusCode, 401);
});

test("新闻源卡片在分页前按启用优先排序，暂停项不会越过启用项", async () => {
  const headers = await session();
  const prefix = "排序测试";
  for (let index = 0; index < 30; index++) {
    const enabled = index >= 15;
    const id = `order-${String(index).padStart(2, "0")}`;
    // Paused names sort before enabled names under the old name-first order.
    const name = `${prefix} ${enabled ? "99 启用" : "00 暂停"} ${String(index).padStart(2, "0")}`;
    const result = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name, kind: "rss", enabled, config: { feedUrl: `https://order.example/${id}` } } });
    assert.equal(result.statusCode, 200);
  }
  const rows: Array<{ id: string; enabled: boolean }> = [];
  let page = 1, hasMore = true, total = 0;
  while (hasMore && page <= 6) {
    const result = await app.inject({ url: "/api/admin/studio/news-sources?" + new URLSearchParams({ q: prefix, limit: "7", page: String(page) }), headers });
    assert.equal(result.statusCode, 200);
    const data = result.json();
    total = data.total; hasMore = data.hasMore; page++;
    rows.push(...data.rows);
  }
  assert.equal(total, 30);
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map(row => row.id)).size, 30);
  assert.equal(rows.filter(row => row.enabled).length, 15);
  assert.equal(rows.filter(row => !row.enabled).length, 15);
  let pausedSeen = false;
  for (const row of rows) {
    if (!row.enabled) pausedSeen = true;
    else assert.equal(pausedSeen, false, "enabled source appeared after a paused source");
  }
});
