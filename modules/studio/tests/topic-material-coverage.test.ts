import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { studio } from "../server.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
let batchId: string;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("超过一页的冻结材料仍可完整检查归类进度，翻页不调用模型，关闭模型时不能提交付费任务", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  await resources.warm(); config.modelCallsEnabled = false;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "analysis-coverage-news", name: "材料覆盖测试", kind: "rss", config: { feedUrl: "https://analysis-coverage.example/feed" } } })).statusCode, 200);
  for (let index = 0; index < 101; index++) await upsertMaterial({ sourceId: "analysis-coverage-news", title: `影视材料${index}`,
    url: `https://analysis-coverage.example/${index}`, via: "import", discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "有出处的完整正文", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200); batchId = frozen.json().batch.id;
  const url = `/api/admin/studio/topic-batches/${batchId}/analysis`;
  const first = (await app.inject({ url: url + "?page=1&limit=100", headers })).json();
  assert.equal(first.total, 101); assert.equal(first.analyzed, 0); assert.equal(first.pending, 101);
  assert.equal(first.rows.length, 100); assert.equal(first.hasMore, true);
  const second = (await app.inject({ url: url + "?page=2&limit=100", headers })).json();
  assert.equal(second.rows.length, 1); assert.equal(second.hasMore, false); assert.equal(second.page, 2);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.materialId)).size, 101);
  assert.ok([...first.rows, ...second.rows].every(row => row.state === "not_analyzed"));
  const displayed = (await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}/materials?page=1&limit=100`, headers })).json();
  assert.deepEqual(first.rows.map((row: { materialId: string }) => row.materialId), displayed.rows.map((row: { id: string }) => row.id), "材料和分析分页保持相同顺序，避免页面丢失对应结果");
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
});

test("手动提交后即使自动截止关闭也会补排剩余材料，百条上限不丢第一百零一条，重复调度不重复排队", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  config.modelCallsEnabled = true;
  const url = `/api/admin/studio/topic-batches/${batchId}/analysis`;
  const first = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(first.statusCode, 200); assert.equal(first.json().queuedCount, 100);
  const schedule = studio.schedules?.find(item => item.name === "studio.topic.material-analysis.schedule");
  assert.ok(schedule, "需要持久补排入口，不能把前100条当全部覆盖");
  assert.deepEqual(await schedule.run(), { queued: 1 });
  assert.deepEqual(await schedule.run(), { queued: 0 });
  const boss = await getBoss(), queued = await boss.findJobs("studio.topic.material-analysis", { queued: true });
  assert.equal(queued.length, 101);
  assert.equal(new Set(queued.map(job => (job.data as { materialId: string }).materialId)).size, 101);
  const second = (await app.inject({ url: url + "?page=2&limit=100", headers })).json();
  assert.equal(second.rows[0].state, "queued"); assert.equal(second.analyzed, 0); assert.equal(second.pending, 101);
});
