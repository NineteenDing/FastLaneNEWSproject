import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
const url = "/api/admin/studio/filter-settings";

test("公开与内部评分默认值可读，规则保存追加版本且旧窗口冲突，不调用模型或改写旧版本", async () => {
  assert.equal((await app.inject({ url })).statusCode, 401);
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const initial = response.json().policy;
  assert.equal(initial.version, 2); assert.equal(initial.schemaVersion, 2);
  assert.deepEqual(initial.editorial.public.weights, { interest: 25, impact: 25, substance: 15, practical: 10, freshness: 5, heat: 20 });
  assert.deepEqual(initial.editorial.internal.weights, { heat: 20, interest: 25, impact: 20, evidence: 15, distinctiveness: 10, practical: 5, freshness: 5 });
  assert.equal(initial.editorial.windows.allHours, 120); assert.equal(initial.editorial.windows.selectedHours, 48);
  assert.equal(initial.editorial.heat.decisionPlaceholder, 40); assert.equal(initial.editorial.freshness.unknownDecision, 40);
  assert.equal(initial.propagation.observedViews, 1000000); assert.equal(initial.propagation.independentAuthors, 3);
  const changed = { ...initial, editorial: { ...initial.editorial, public: { ...initial.editorial.public,
    weights: { ...initial.editorial.public.weights, practical: 15, heat: 15 } } },
    propagation: { ...initial.propagation, observedViews: 1200000 } };
  const saved = await app.inject({ method: "PUT", url, headers, payload: changed }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().policy.version, 3); assert.equal(saved.json().policy.editorial.public.weights.heat, 15);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: changed })).statusCode, 409);
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload: { ...changed, version: 3 } })).statusCode, 403);
  const previous = await app.inject({ url: url + "/versions/1", headers }); assert.equal(previous.statusCode, 200);
  assert.equal(previous.json().policy.version, 1);
  assert.deepEqual(previous.json().policy.public.weights, { practical: 35, interest: 25, heat: 20, substance: 12, freshness: 8 });
  assert.equal((await app.inject({ url, headers })).json().policy.propagation.observedViews, 1200000);
});

test("无效权重与倒序档位不能保存；新栏目可映射公开归属且不重命名历史规则", async () => {
  const initial = (await app.inject({ url, headers })).json().policy;
  for (const payload of [
    { ...initial, public: { ...initial.public, weights: { ...initial.public.weights, heat: 99 } } },
    { ...initial, internal: { weights: { ...initial.internal.weights, impact: -5 } } },
    { ...initial, heat: { ...initial.heat, reporterBands: [{ at: 5, value: 70 }, { at: 3, value: 40 }] } },
    { ...initial, freshness: { ...initial.freshness, bands: [{ hours: 6, value: 50 }, { hours: 24, value: 100 }] } },
    { ...initial, propagation: { ...initial.propagation, observedViews: 0 } },
    { ...initial, editorial: { ...initial.editorial, public: { ...initial.editorial.public, weights: { ...initial.editorial.public.weights, heat: 99 } } } },
    { ...initial, editorial: { ...initial.editorial, heat: { ...initial.editorial.heat,
      reporterAnchors: [[0, 0], [5, 40], [1, 20]] } } },
  ]) assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 400);
  const { editorial: _editorial, ...withoutV2 } = initial;
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: withoutV2 })).statusCode, 409);
  assert.equal((await app.inject({ url, headers })).json().policy.version, initial.version);
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/columns", headers,
    payload: { name: "版权与交付", questions: "影视作品交付与授权", videoForms: "合同边界说明" } });
  assert.equal(added.statusCode, 200, added.body);
  const column = added.json().column;
  const changed = { ...initial, columnMapping: { ...initial.columnMapping, [column.id]: "news" } };
  const saved = await app.inject({ method: "PUT", url, headers, payload: changed });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().policy.columnMapping[column.id], "news");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/" + column.id, headers,
    payload: { version: column.version, name: "交付与版权" } })).statusCode, 200);
  const previous = (await app.inject({ url: url + "/versions/" + initial.version, headers })).json().policy;
  assert.equal(previous.columnMapping[column.id], undefined);
  assert.equal((await app.inject({ url, headers })).json().policy.columnMapping[column.id], "news");
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...saved.json().policy,
    columnMapping: { ...saved.json().policy.columnMapping, removed_column: "news" } } })).statusCode, 409);
  assert.equal((await app.inject({ url: url + "/versions/9999", headers })).statusCode, 404);
});
