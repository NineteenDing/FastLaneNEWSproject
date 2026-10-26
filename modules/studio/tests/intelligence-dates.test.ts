import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("情报日期归档按香港日界划分收录与发布，保留无发布日期并可组合全文筛选", async () => {
  config.adminPassword = "archive-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ username: config.adminUsername ?? "admin", password: "archive-test-password" }).toString() });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } }), headers = { cookie, "x-csrf-token": me.json().csrf };
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "archive-news", name: "影视归档观察", kind: "rss", config: { feedUrl: "https://archive.example/rss" } } })).statusCode, 200);
  for (const [title, collected, published] of [
    ["午夜前", "2026-09-30T15:59:59Z", "2026-09-28T16:00:00Z"],
    ["午夜后", "2026-09-30T16:00:00Z", "2026-09-30T16:00:00Z"],
    ["无发布日期", "2026-10-01T15:59:59Z", null],
  ] as const) await upsertMaterial({ sourceId: "archive-news", title, url: `https://archive.example/${encodeURIComponent(title)}`, via: "import",
    discoveredAt: new Date(collected), publishedAt: published ? new Date(published) : null, bodyText: "角色参考归档正文", bodyStatus: "ok" });
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence/dates" })).statusCode, 401);
  const read = async (query: string) => app.inject({ url: "/api/admin/studio/intelligence/dates?" + query, headers });
  const dates = await read("month=2026-10");
  assert.equal(dates.statusCode, 200); assert.equal(dates.headers["cache-control"], "no-store");
  assert.deepEqual(dates.json(), { basis: "collected", month: "2026-10", months: [{ month: "2026-10", total: 2 }, { month: "2026-09", total: 1 }], days: [{ day: "2026-10-01", total: 2 }], undatedTotal: 0 });
  const published = await read("basis=published&month=2026-09");
  assert.equal(published.statusCode, 200);
  assert.deepEqual(published.json().days, [{ day: "2026-09-29", total: 1 }]);
  assert.equal(published.json().undatedTotal, 1);
  const list = async (query: string) => app.inject({ url: "/api/admin/studio/intelligence?" + query, headers });
  assert.equal((await list("day=2026-09-30")).json().rows[0].title, "午夜前");
  assert.equal((await list("day=2026-10-01&basis=collected")).json().total, 2);
  assert.equal((await list("day=2026-09-29&basis=published")).json().rows[0].title, "午夜前");
  assert.equal((await list("day=undated&basis=published")).json().rows[0].title, "无发布日期");
  assert.equal((await list("day=2026-10-01&q=" + encodeURIComponent("角色参考") + "&platform=news&kind=news")).json().total, 2);
  for (const query of ["day=2026-02-30", "basis=other", "day=undated"]) assert.equal((await list(query)).statusCode, 400);
  for (const query of ["month=2026-13", "month=2026-1", "basis=other"]) assert.equal((await read(query)).statusCode, 400);
});
