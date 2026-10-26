import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("内部当天动态按香港午夜划分收录，昨天深夜只留在24小时查询和日期归档", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T16:05:00Z") });
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "calendar-source", name: "日历来源", kind: "rss", enabled: false, config: { feedUrl: "https://calendar.example/feed" },
  } }); assert.equal(created.statusCode, 200, created.body);
  for (const [id, at] of [["yesterday", "2026-10-24T15:55:00Z"], ["today", "2026-10-24T16:01:00Z"]]) {
    await upsertMaterial({ sourceId: "calendar-source", title: id!, url: `https://calendar.example/${id}`, via: "import",
      discoveredAt: new Date(at!), publishedAt: new Date(at!), bodyText: "未经过分析的内部新闻也须完整显示。", bodyStatus: "ok" });
  }
  const today = await app.inject({ url: "/api/admin/studio/intelligence?recent=today", headers });
  assert.equal(today.statusCode, 200, today.body); assert.equal(today.json().total, 1); assert.equal(today.json().rows[0].title, "today");
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?recent=24h", headers })).json().total, 2);
  const archive = await app.inject({ url: "/api/admin/studio/intelligence?basis=collected&day=2026-10-24", headers });
  assert.equal(archive.statusCode, 200); assert.equal(archive.json().total, 1); assert.equal(archive.json().rows[0].title, "yesterday");
});
