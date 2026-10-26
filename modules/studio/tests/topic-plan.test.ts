import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await closeDb(); });

test("私有两日计划默认关闭，可保存自定义起点并切换当前48小时窗口，旧窗口不能覆盖计划", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-plan" })).statusCode, 401);
  const initial = await app.inject({ url: "/api/admin/studio/topic-plan", headers });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().enabled, false);
  assert.equal(initial.json().version, 0);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers: { cookie: headers.cookie },
    payload: { version: 0, enabled: true, startsAt: "2026-10-17T10:00:00Z" } })).statusCode, 403);
  const saved = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: true, startsAt: "2026-10-17T10:00:00Z" } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().version, 1);
  assert.equal(saved.json().startsAt, "2026-10-17T10:00:00.000Z");
  assert.equal(saved.json().enabled, true);
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal(current.startsAt, "2026-10-17T10:00:00.000Z");
  assert.equal(current.endsAt, "2026-10-19T10:00:00.000Z");
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: false, startsAt: "2026-10-16T12:00:00Z" } })).statusCode, 409);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json(), saved.json());
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
  t.mock.timers.setTime(new Date("2026-10-17T09:00:00Z").getTime());
  const planned = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal(planned.startsAt, "2026-10-17T10:00:00.000Z", "未到首批开始时间，不能虚构更早的批次");
  assert.equal(planned.stage, "scheduled");
});

test("冻结历史遵循自定义起点，之后可暂停自动处理但不能移动已确定的48小时边界", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T10:00:00Z") });
  await resources.warm();
  for (const startsAt of ["2026-10-15T10:00:00Z", "2026-10-19T10:00:00Z"])
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } })).statusCode, 409,
      "首个冻结不能绕过配置起点，提前或跳过首批");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers,
    payload: { startsAt: "2026-10-17T10:00:00.000Z" } });
  assert.equal(frozen.statusCode, 200);
  assert.equal(frozen.json().batch.endsAt, "2026-10-19T10:00:00.000Z");
  const moved = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 1, enabled: true, startsAt: "2026-10-17T12:00:00Z" } });
  assert.equal(moved.statusCode, 409);
  assert.match(moved.json().detail, /已有批次/);
  const paused = await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 1, enabled: false, startsAt: "2026-10-17T10:00:00Z" } });
  assert.equal(paused.statusCode, 200); assert.equal(paused.json().version, 2);
  assert.equal(paused.json().enabled, false);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}`, headers })).json(), frozen.json());
});
