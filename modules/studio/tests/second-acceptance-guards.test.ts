import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

process.env.COLLECT_ENABLED = "false"; config.modelCallsEnabled = false; config.allowPrivateNetworkFetch = true;
const resources = await sourceResourceFixture(), { app, headers } = resources;
await resources.warm();
const provider = await stub((_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  const result = input.material ? { columnId: "practice", disposition: "background", summary: "资料有参考价值，但尚不足以形成选题", reason: "保留条件与背景", viewerBenefit: "了解适用条件", event: "制作条件对照", evidenceQuotes: [input.material.body.slice(0, 100)], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } }
    : { directions: [], assignments: input.materials.map(({ material }: { material: { id: string } }) => ({ materialId: material.id, columnId: "practice", disposition: "background", directionIds: [], reason: "完整资料保留为背景" })) };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 40 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "local-boundary-fixture", LLM_MODEL: "local-boundary-fixture" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("其他冻结批次仅通过补充引用示例时，清理仍必须整批拒绝", async () => {
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: plan.startsAt } });
  assert.equal(frozen.statusCode, 200, frozen.body);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/acceptance-examples", headers, payload: {} })).statusCode, 200);
  const materials = (await app.inject({ url: "/api/admin/studio/intelligence?q=示例&limit=100", headers })).json();
  const extra = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/supplements`, headers, payload: { columnId: "practice", materialIds: [materials.rows.find((r: { kind: string }) => r.kind === "news").id] } });
  assert.equal(extra.statusCode, 200, extra.body);
  const clear = await app.inject({ method: "DELETE", url: "/api/admin/studio/acceptance-examples", headers, payload: {} });
  assert.equal(clear.statusCode, 409); assert.equal((await app.inject({ url: "/api/admin/studio/acceptance-examples", headers })).json().active, true);
});

test("新快照加保留展示超过2MiB时不排新任务，旧展示与完整正文保留", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "guard-source", name: "边界材料", kind: "rss", enabled: false, config: { feedUrl: "https://guard.example/feed" } } });
  await upsertMaterial({ sourceId: "guard-source", url: "https://guard.example/previous", title: "旧完整材料", via: "import", discoveredAt: new Date("2026-10-29T12:30:00Z"), bodyText: "a ".repeat(300000), bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", current = (await app.inject({ url: endpoint, headers })).json();
  const start = await app.inject({ method: "POST", url: endpoint, headers, payload: { startsAt: current.startsAt } });
  assert.equal(start.statusCode, 200, start.body);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const previous = (await app.inject({ url: endpoint, headers })).json(); assert.equal(previous.state, "draft"); assert.ok(previous.result);
  await upsertMaterial({ sourceId: "guard-source", url: "https://guard.example/current", title: "新完整材料", via: "import", discoveredAt: new Date("2026-10-29T12:40:00Z"), bodyText: "b ".repeat(600000), bodyStatus: "ok" });
  const calls = provider.hits(), submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { startsAt: current.startsAt } });
  assert.equal(submitted.statusCode, 409);
  const saved = (await app.inject({ url: endpoint, headers })).json(); assert.deepEqual(saved.result, previous.result); assert.match(saved.inputIssue, /2MiB|预算|上限/); assert.equal(provider.hits(), calls);
});
