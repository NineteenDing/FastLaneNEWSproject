import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("截止后的选题保留到第三天午夜，下一期继续收集；未采纳到期转未完成且历史不删除", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  await resources.warm();
  const path = "/api/admin/studio/topic-batches/presentation";
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); const id = frozen.json().batch.id;
  const read = () => app.inject({ url: path, headers });
  const ready = await read(); assert.equal(ready.statusCode, 200, ready.body); assert.equal(ready.headers["cache-control"], "no-store");
  assert.equal(ready.json().batch.id, id); assert.equal(ready.json().displayUntil, "2026-10-19T16:00:00.000Z");
  assert.equal(ready.json().collection.startsAt, "2026-10-18T12:00:00.000Z");
  t.mock.timers.setTime(new Date("2026-10-19T15:59:59.999Z").getTime());
  assert.equal((await read()).json().batch.id, id);
  t.mock.timers.setTime(new Date("2026-10-19T16:00:00Z").getTime());
  const next = (await read()).json(); assert.equal(next.batch, null); assert.equal(next.collection.startsAt, "2026-10-18T12:00:00.000Z");
  const history = await app.inject({ url: `/api/admin/studio/topic-batches/${id}`, headers });
  assert.equal(history.statusCode, 200); assert.equal(history.json().batch.selectionState, "incomplete");
  assert.equal(history.json().batch.adoptionState, "not_adopted"); assert.equal(history.json().batch.materialCount, 0);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 1);
});

test("选题原文弹窗读取冻结时正文，后续来源更正不改历史且越批引用不能读取", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") }); await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "presentation-news", name: "选题原文", kind: "rss", config: { feedUrl: "https://presentation.example/feed" } } })).statusCode, 200);
  const input = { sourceId: "presentation-news", title: "角色参考的限制", url: "https://presentation.example/reference", via: "import" as const,
    discoveredAt: new Date("2026-10-19T08:00:00Z"), bodyStatus: "ok" as const };
  const saved = await upsertMaterial({ ...input, bodyText: "当时原稿：需要逐镜检查角色一致性。" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  const path = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials/${encodeURIComponent("news:" + saved.articleId)}`;
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  await upsertMaterial({ ...input, bodyText: "之后更正：不应直接照搬旧参数。" });
  const original = await app.inject({ url: path, headers }); assert.equal(original.statusCode, 200, original.body);
  assert.equal(original.headers["cache-control"], "no-store"); assert.equal(original.json().body, "当时原稿：需要逐镜检查角色一致性。");
  const other = await upsertMaterial({ ...input, url: "https://presentation.example/other", bodyText: "未进入这个冻结批次的新资料。" });
  assert.equal((await app.inject({ url: path.replace(encodeURIComponent("news:" + saved.articleId), encodeURIComponent("news:" + other.articleId)), headers })).statusCode, 404);
});

test("历史批次按日期和标题关键词在分页前筛选，显示真实已确认稿件和采纳方向", async () => {
  const read = (query: string) => app.inject({ url: "/api/admin/studio/topic-batches?" + query, headers });
  const dates = await read("from=2026-10-20&to=2026-10-20&limit=1"); assert.equal(dates.statusCode, 200, dates.body);
  assert.equal(dates.json().total, 1); assert.equal(dates.json().rows[0].startsAt, "2026-10-18T12:00:00.000Z");
  assert.equal(dates.json().rows[0].finalizedDraftCount, 0); assert.deepEqual(dates.json().rows[0].adoptedDirectionIds, []);
  assert.equal((await read("q=2026-10-16")).json().total, 1);
  assert.equal((await read("q=%25")).json().total, 0);
  assert.equal((await read("from=2026-10-20&to=2026-10-19")).statusCode, 400);
});
