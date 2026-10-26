import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { QueueDeferred } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { Reply, stub, gate } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only controlled localhost provider fixtures in this test process.
const modelInputs: Array<{ preview?: unknown; material?: { id: string; body: string }; materials?: Array<{ material: { id: string; body: string } }> }> = [];
let failSynthesis = false;
let onSynthesis: (() => void) | undefined;
let heldRequests: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; count: number } | undefined;
const provider = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content); modelInputs.push(input);
  if (input.hold) {
    const hold = heldRequests; assert.ok(hold);
    if (++hold.count === 2) hold.entered.open();
    await hold.release.promise;
    return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  }
  if (failSynthesis && input.materials) return new Reply(503, { error: "controlled preview fixture failure" });
  if (input.materials) onSynthesis?.();
  const dimensions = { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 };
  const gates = { audience: true, evidence: true, benefit: true };
  const result = input.material ? { columnId: "practice", disposition: "support", summary: "有明确操作和限制", reason: "可用来演示对照步骤",
    viewerBenefit: "知道如何对照镜头", event: "角色与光线", evidenceQuotes: [input.material.body], dimensions, gates }
    : { directions: [{ id: "reference-light", columnId: "practice", eventKey: "reference-light", question: "如何同时检查角色与光线",
      viewerBenefit: "学会两个镜头的角色和光线检查", whyNow: "两份新操作说明可以结合", angle: "先固定参考图再统一对照光线",
      usage: { steps: ["固定角色参考", "对照光线条件"], conditions: ["有两个镜头可比较"], limitations: ["复杂运动仍未验证"] },
      titles: ["两个镜头怎么同时检查角色和光线", "先固定参考，再检查光线", "镜头一致性先核对这两步"], preferredTitle: 0,
      structure: { opening: "指出跨镜头问题", rhythm: "操作后对照", ending: "说明未验证范围" }, dimensions, gates,
      references: input.materials.map(({ material }: { material: { id: string; body: string } }) => ({ materialId: material.id, role: "fact", quote: material.body, reason: "实际操作与限制" })) }],
      assignments: input.materials.map(({ material }: { material: { id: string } }) => ({ materialId: material.id, columnId: "practice", disposition: "support", directionIds: ["reference-light"], reason: "可结合演示" })) };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 40 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "topic-preview-fixture-key", LLM_MODEL: "topic-preview-fixture" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("当期候选草案读取有权限与真实覆盖信息，未生成不冒充审核或冻结材料且刷新不调用模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T12:00:00Z") });
  config.modelCallsEnabled = false; await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "topic-preview-news", name: "制作流程来源", kind: "rss", config: { feedUrl: "https://preview.example/feed" },
  } })).statusCode, 200);
  await upsertMaterial({ sourceId: "topic-preview-news", title: "两镜头角色一致性的新操作", url: "https://preview.example/reference", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"),
    bodyText: "固定角色参考图后再对照两个镜头，尚未验证复杂运动。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview";
  const original = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json();
  assert.equal(original.total, 1);
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  for (let refresh = 0; refresh < 2; refresh++) {
    const response = await app.inject({ url: endpoint, headers });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "no-store");
    const value = response.json();
    assert.equal(value.startsAt, "2026-10-16T12:00:00.000Z"); assert.equal(value.endsAt, "2026-10-18T12:00:00.000Z");
    assert.equal(value.state, "not_generated"); assert.equal(value.reviewState, "not_started");
    assert.equal(value.materialCount, 1); assert.equal(value.analysisPendingCount, 1);
    assert.equal(value.result, null); assert.equal(value.generatedAt, null); assert.equal(value.modelEnabled, false);
  }
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json(), original);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
  assert.equal(provider.hits(), 0);
});

test("显式提交当期草案经持久队列综合两份已分析材料，重复提交和读取复用结果且不冻结正式批次", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T12:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "跨镜头光线的对照条件", url: "https://preview.example/lighting", via: "import",
    discoveredAt: new Date("2026-10-17T11:00:00Z"), publishedAt: new Date("2026-10-17T10:00:00Z"),
    bodyText: "对照光线时先固定同一场景条件，复杂运动仍需逐镜检查。", bodyStatus: "ok" });
  const studio = serverModules().find(module => module.name === "studio")!, boss = await getBoss();
  const analysisSchedule = studio.schedules!.find(schedule => schedule.name === "studio.topic.material-analysis.schedule")!;
  await analysisSchedule.run();
  const analysisQueue = studio.queues!.find(queue => queue.name === "studio.topic.material-analysis")!;
  for (let index = 0; index < 2; index++) { const [job] = await boss.fetch(analysisQueue.name); assert.ok(job); await analysisQueue.run([job.data] as never[]); await boss.complete(analysisQueue.name, job.id); }
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json().analysisCompletedCount, 2);
  const original = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json();
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-16T12:00:00.000Z" }, calls = provider.hits();
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(submitted.statusCode, 200, submitted.body); assert.equal(submitted.json().queued, true);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().queued, false);
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "queued"); assert.equal(provider.hits(), calls);
  const queue = studio.queues!.find(queue => queue.name === "studio.topic.preview"); assert.ok(queue);
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const result = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(result.state, "draft"); assert.equal(result.reviewState, "not_started"); assert.equal(result.generatedAt, "2026-10-17T12:00:00.000Z");
  assert.equal(result.result.directions.length, 1); assert.equal(result.result.directions[0].question, "如何同时检查角色与光线");
  assert.equal(result.result.directions[0].references.length, 2); assert.equal(result.result.assignments.length, 2);
  assert.equal(result.includedMaterialCount, 2); assert.equal(provider.hits(), calls + 1, "复用已有精确上下文初筛，只新增一次综合调用");
  const materialPath = `/api/admin/studio/topic-previews/${result.id}/versions/${result.version}/materials/${encodeURIComponent(result.referenceMaterials[0].id)}`;
  assert.equal((await app.inject({ url: materialPath })).statusCode, 401);
  const evidence = await app.inject({ url: materialPath, headers });
  assert.equal(evidence.statusCode, 200, evidence.body); assert.equal(evidence.headers["cache-control"], "no-store");
  assert.equal(evidence.json().body, "固定角色参考图后再对照两个镜头，尚未验证复杂运动。");
  assert.equal((await app.inject({ url: materialPath.replace(`/versions/${result.version}/`, "/versions/999/"), headers })).statusCode, 409);
  assert.ok(modelInputs.at(-1)!.preview, "综合输入必须明确是收集中的未审核草案");
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), result);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().queued, false);
  assert.equal(provider.hits(), calls + 1);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json(), original);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("当前原稿更正后明确标记草案陈旧，读取保留原依据不付费，显式更新只重做变化上下文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-16T12:00:00.000Z" };
  const original = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  assert.equal(original.stale, false);
  await upsertMaterial({ sourceId: "topic-preview-news", title: "两镜头角色一致性的新操作", url: "https://preview.example/reference", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "更正：参考图只用于固定机位，尚未验证运动镜头。", bodyStatus: "ok" });
  const outdated = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(outdated.stale, true); assert.deepEqual(outdated.result, original.result); assert.equal(outdated.generatedAt, original.generatedAt);
  assert.equal(provider.hits(), calls);
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(submitted.statusCode, 200, submitted.body); assert.equal(submitted.json().queued, true);
  const updating = (await app.inject({ url: endpoint, headers })).json();
  assert.deepEqual(updating.result, original.result, "后台更新时继续显示上一版选题，不清空栏目");
  assert.equal(updating.version, original.version, "展示中的引用仍使用上一版精确依据");
  const visiblePath = `/api/admin/studio/topic-previews/${original.id}/versions/${original.version}/materials/${encodeURIComponent(original.referenceMaterials[0].id)}`;
  assert.equal((await app.inject({ url: visiblePath, headers })).statusCode, 200);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const updated = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(updated.stale, false); assert.equal(updated.version, original.version + 1); assert.equal(updated.id, original.id);
  const oldMaterialPath = `/api/admin/studio/topic-previews/${original.id}/versions/${original.version}/materials/${encodeURIComponent(original.referenceMaterials[0].id)}`;
  assert.equal((await app.inject({ url: oldMaterialPath, headers })).statusCode, 409, "旧弹窗不能偷偷读取新预览的正文");
  assert.equal(updated.generatedAt, "2026-10-17T13:00:00.000Z"); assert.ok(JSON.stringify(updated.result).includes("参考图只用于固定机位"));
  assert.ok(!JSON.stringify(updated.result).includes("固定角色参考图后再对照两个镜头"));
  assert.equal(provider.hits(), calls + 2, "只对更正原稿重新初筛，再做一次综合；不重复分析没变的另一篇");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("两日窗口截止后旧预览任务不再消耗模型费用，旧页面不能向下一窗提交或把草案当正式审核结果", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T14:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "声音与镜头对齐的条件", url: "https://preview.example/audio", via: "import",
    discoveredAt: new Date("2026-10-17T13:30:00Z"), publishedAt: new Date("2026-10-17T13:00:00Z"), bodyText: "先对齐配音再检查镜头节奏，尚未验证所有素材。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-16T12:00:00.000Z" };
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true); const calls = provider.hits();
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime());
  const current = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(current.startsAt, "2026-10-18T12:00:00.000Z"); assert.equal(current.state, "not_generated"); assert.equal(current.result, null);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  assert.equal(provider.hits(), calls, "已截止的旧候选任务不得再启动初筛或综合调用");
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), current);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("失败草案只显式重试原输入，原稿已更正时不偷换材料，随后明确更新才使用新上下文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const originalBody = "先核对音轨与分镜对应关系，尚未验证复杂场景。", updatedBody = "更正：音轨对照仅验证了固定机位，不应推广到复杂运动。";
  await upsertMaterial({ sourceId: "topic-preview-news", title: "音轨与分镜对照", url: "https://preview.example/new-audio", via: "import",
    discoveredAt: new Date("2026-10-18T12:30:00Z"), publishedAt: new Date("2026-10-18T12:20:00Z"), bodyText: originalBody, bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-18T12:00:00.000Z" };
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload }); assert.equal(submitted.statusCode, 200);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); failSynthesis = true;
  try { await assert.rejects(queue.run([job.data] as never[])); } finally { failSynthesis = false; }
  await boss.cancel(queue.name, job.id);
  const failed = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  assert.equal(failed.state, "failed"); assert.equal(failed.result, null); assert.ok(!failed.error.includes("controlled preview fixture failure"));
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().queued, false);
  assert.equal(provider.hits(), calls);
  t.mock.timers.setTime(new Date("2026-10-18T13:30:00Z").getTime());
  await upsertMaterial({ sourceId: "topic-preview-news", title: "音轨与分镜对照", url: "https://preview.example/new-audio", via: "import",
    discoveredAt: new Date("2026-10-18T12:30:00Z"), bodyText: updatedBody, bodyStatus: "ok" });
  const retried = await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, retryFailed: true } });
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().queued, true); assert.equal(retried.json().id, failed.id);
  const [retry] = await boss.fetch(queue.name); assert.ok(retry); await queue.run([retry.data] as never[]); await boss.complete(queue.name, retry.id);
  const retained = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(modelInputs.at(-1)!.materials![0]!.material.body, originalBody);
  assert.equal(retained.version, failed.version); assert.equal(retained.capturedAt, failed.capturedAt); assert.equal(retained.stale, true);
  assert.equal(provider.hits(), calls + 1, "失败前已完成的原初筛缓存复用，重试只补原综合");
  const updated = await app.inject({ method: "POST", url: endpoint, headers, payload }); assert.equal(updated.statusCode, 200); assert.equal(updated.json().queued, true);
  const [refresh] = await boss.fetch(queue.name); assert.ok(refresh); await queue.run([refresh.data] as never[]); await boss.complete(queue.name, refresh.id);
  const latest = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(latest.version, failed.version + 1); assert.equal(latest.stale, false); assert.ok(JSON.stringify(latest.result).includes(updatedBody));
  assert.equal(provider.hits(), calls + 3);
});

test("综合回复跨过截止时不发布过期草案，已发送请求有据记费但不污染下一期或正式批次", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T14:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "运动镜头的补充限制", url: "https://preview.example/motion", via: "import",
    discoveredAt: new Date("2026-10-18T13:50:00Z"), bodyText: "运动镜头需要另做对照测试，不能把固定机位结论直接推广。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-18T12:00:00.000Z" };
  const shownBeforeUpdate = (await app.inject({ url: endpoint, headers })).json();
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload }); assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); onSynthesis = () => t.mock.timers.setTime(new Date("2026-10-20T12:00:00Z").getTime());
  try { await queue.run([job.data] as never[]); } finally { onSynthesis = undefined; }
  await boss.complete(queue.name, job.id);
  const next = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(next.startsAt, "2026-10-20T12:00:00.000Z"); assert.equal(next.state, "not_generated"); assert.equal(next.result, null);
  t.mock.timers.setTime(new Date("2026-10-18T14:00:00Z").getTime());
  const expired = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(expired.state, "failed"); assert.deepEqual(expired.result, shownBeforeUpdate.result, "失败的迟到结果不发布，仍只保留原来的有效选题"); assert.match(expired.error, /截止/);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("栏目当前选题由后台每五分钟检查，十五分钟内合并更新且相同上下文不重复调用", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const studio = serverModules().find(module => module.name === "studio")!, schedule = studio.schedules!.find(item => item.name === "studio.topic.preview.schedule");
  assert.ok(schedule, "自动候选通过原后台调度，而不是访问页面时付费");
  assert.equal(schedule.cron, "*/5 * * * *", "无需用户点生成，后台定期检查已准备材料");
  await upsertMaterial({ sourceId: "topic-preview-news", title: "角色对照新方法", url: "https://preview.example/auto-first", via: "import",
    discoveredAt: new Date("2026-10-20T12:30:00Z"), bodyText: "先保存角色参考再比较镜头，运动场景仍需验证。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", calls = provider.hits();
  assert.equal((await schedule.run() as { queued: boolean }).queued, false);
  const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers, payload: { version: plan.version, enabled: true, startsAt: plan.startsAt } })).statusCode, 200);
  config.modelCallsEnabled = false;
  assert.equal((await schedule.run() as { queued: boolean }).queued, false); config.modelCallsEnabled = true;
  assert.equal((await schedule.run() as { queued: boolean }).queued, true);
  assert.equal((await schedule.run() as { queued: boolean }).queued, false); assert.equal(provider.hits(), calls);
  const queue = studio.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss();
  const [first] = await boss.fetch(queue.name); assert.ok(first); await queue.run([first.data] as never[]); await boss.complete(queue.name, first.id);
  const original = (await app.inject({ url: endpoint, headers })).json();
  t.mock.timers.setTime(new Date("2026-10-20T13:10:00Z").getTime());
  await upsertMaterial({ sourceId: "topic-preview-news", title: "新的光线对照条件", url: "https://preview.example/auto-second", via: "import",
    discoveredAt: new Date("2026-10-20T13:05:00Z"), bodyText: "光线对照需要固定背景，尚未验证多光源场景。", bodyStatus: "ok" });
  assert.equal((await schedule.run() as { queued: boolean }).queued, false);
  assert.equal((await app.inject({ url: endpoint, headers })).json().version, original.version);
  t.mock.timers.setTime(new Date("2026-10-20T13:16:00Z").getTime());
  assert.equal((await schedule.run() as { queued: boolean }).queued, true);
  const [second] = await boss.fetch(queue.name); assert.ok(second); await queue.run([second.data] as never[]); await boss.complete(queue.name, second.id);
  const updated = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(updated.version, original.version + 1); assert.equal(updated.includedMaterialCount, 2);
  const completedCalls = provider.hits();
  t.mock.timers.setTime(new Date("2026-10-21T13:00:00Z").getTime());
  assert.equal((await schedule.run() as { queued: boolean }).queued, false);
  assert.equal(provider.hits(), completedCalls); assert.equal(completedCalls, calls + 4);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
});

test("候选草案让出用户写稿执行位，普通持续采集不会造成饥饿", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T14:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "配音检查的新增条件", url: "https://preview.example/priority", via: "import",
    discoveredAt: new Date("2026-10-21T13:30:00Z"), bodyText: "配音检查应保留停顿，背景音乐会影响判断。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-20T12:00:00.000Z" };
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().queued, true);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); const pending = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  const collecting = await app.inject({ method: "POST", url: "/api/admin/sources/topic-preview-news/fetch", headers, payload: {} });
  assert.equal(collecting.statusCode, 200); const priority = collecting.json().jobId; assert.ok(priority);
  await boss.createQueue("studio.writing.generate");const writing=await boss.send("studio.writing.generate",{});assert.ok(writing);
  try {
    await assert.rejects(queue.run([job.data] as never[]), QueueDeferred);
    assert.equal(provider.hits(), calls); assert.equal((await app.inject({ url: endpoint, headers })).json().state, "queued");
  } finally { await boss.cancel("studio.writing.generate",writing); }
  // Keep the ordinary ingestion pending: the preview must still complete.

  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);await boss.cancel("sources.fetch",priority);
  const completed = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(completed.state, "draft"); assert.equal(completed.version, pending.version + 1); assert.equal(completed.capturedAt, "2026-10-21T14:00:00.000Z");
  assert.equal(provider.hits(), calls + 2);
});

test("真实网页可查看候选七点与原链接，显式更新且按原规则保留，在途材料变化不偷换输入，桌面窄屏均不能直接采纳", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T15:00:00Z") });
  config.modelCallsEnabled = false; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "草案新增分镜检查", url: "https://preview.example/browser", via: "import",
    discoveredAt: new Date("2026-10-21T14:30:00Z"), bodyText: "先检查分镜再检查光线，不保证运动场景结果。", bodyStatus: "ok" });
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", calls = provider.hits();
  try {
    await page.goto(web.origin + "/admin/studio/topics");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "当期选题", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "实操与提效", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "候选方向草案", exact: true })).toHaveCount(0);
    await expect(page.getByText("查看收集与选题处理详情", { exact: true })).toHaveCount(0);
    await openTopicProcessing(page);
    const section = page.getByRole("region", { name: "候选方向草案", exact: true });
    await expect(section.getByRole("button", { name: "更新候选草案", exact: true })).toBeDisabled();
    await expect(section).toContainText("尚未审核"); assert.equal(provider.hits(), calls);
    config.modelCallsEnabled = true; await page.reload(); await openTopicProcessing(page);
    await section.getByRole("button", { name: "更新候选草案", exact: true }).click();
    await expect(section).toContainText("已排队");
    const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
    assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await section.getByRole("button", { name: "刷新草案进度", exact: true }).click(); await expect(section).toContainText("草案已保存");
    await page.goto(web.origin + "/admin/studio/topics");
    const cards = page.getByLabel("栏目选题", { exact: true });
    await expect(cards.getByText("本栏最推荐", { exact: true })).toHaveCount(1);
    await cards.getByRole("button").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("观众问题与收益", { exact: true })).toBeVisible();
    await expect(dialog.getByText("建议表达结构", { exact: true })).toBeVisible();
    await expect(dialog.locator(".studio-topic-related")).toHaveAttribute("open");
    await expect(dialog.getByRole("link", { name: "原文链接", exact: true })).toHaveCount(4);
    assert.equal(await dialog.getByRole("button", { name: "采纳并写稿", exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "查看保存的内容", exact: true }).first().click();
    const reader = page.getByRole("dialog", { name: "情报详情", exact: true });
    await expect(reader.getByRole("link", { name: "打开原文或原作品", exact: true })).toBeVisible();
    await reader.getByRole("button", { name: "关闭", exact: true }).click();
    await mkdir(".impeccable/review", { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/topic-preview-${width}.png`, fullPage: true });
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await openTopicProcessing(page);
    const doneCalls = provider.hits(); assert.equal(doneCalls, calls + 2);
    await section.getByRole("button", { name: "刷新草案进度", exact: true }).click(); assert.equal(provider.hits(), doneCalls);
    const columns=(await app.inject({url:"/api/admin/studio/columns",headers})).json().rows;
    const currentVersion=columns.find((column:{id:string})=>column.id==="practice").version;
    const renamed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: currentVersion, name: "新实操标准" } });
    assert.equal(renamed.statusCode, 200);
    await section.getByRole("button", { name: "刷新草案进度", exact: true }).click(); await expect(section).toContainText("栏目规则已有变化");
    await section.getByText("查看草案使用的栏目规则", { exact: true }).click();
    await expect(section.getByRole("heading", { name: `实操与提效 · 版本 ${currentVersion}`, exact: true })).toBeVisible();
    await expect(section.getByRole("heading", { name: `新实操标准 · 版本 ${currentVersion+1}`, exact: true })).toHaveCount(0);
    assert.equal(provider.hits(), doneCalls);
    await section.getByRole("button", { name: "更新候选草案", exact: true }).click(); await expect(section).toContainText("已排队");
    const [updatedJob] = await boss.fetch(queue.name); assert.ok(updatedJob);
    await upsertMaterial({ sourceId: "topic-preview-news", title: "草案新增分镜检查", url: "https://preview.example/browser", via: "import",
      bodyText: "更正：只验证了固定机位的分镜，不应推广运动镜头。", bodyStatus: "ok" });
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { startsAt: "2026-10-20T12:00:00.000Z" } })).statusCode, 409);
    await queue.run([updatedJob.data] as never[]); await boss.complete(queue.name, updatedJob.id);
    await section.getByRole("button", { name: "刷新草案进度", exact: true }).click(); await expect(section).toContainText("材料、指标或栏目规则已有变化");
    const saved = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(saved.columns.find((column: { id: string }) => column.id === "practice").version, currentVersion+1);
    assert.ok(JSON.stringify(saved.result).includes("先检查分镜再检查光线")); assert.ok(!JSON.stringify(saved.result).includes("更正：只验证了固定机位"));
    assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0);
  } finally { await browser.close(); await web.stop(); }
});

test("候选材料超预算时不排收费任务也不截断正文，保留已保存草案并明确缺口", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T16:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const endpoint = "/api/admin/studio/topic-batches/current/preview", original = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "长篇制作记录", url: "https://preview.example/large", via: "import",
    discoveredAt: new Date("2026-10-21T15:30:00Z"), bodyText: "有据".repeat(400_000), bodyStatus: "ok" });
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { startsAt: "2026-10-20T12:00:00.000Z" } });
  assert.equal(submitted.statusCode, 409); assert.match(submitted.json().detail, /预算|过大|上限/);
  const reading = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(reading.stale, true); assert.deepEqual(reading.result, original.result); assert.equal(reading.version, original.version);
  assert.match(reading.inputIssue, /预算|过大|上限/); assert.equal(provider.hits(), calls);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials?limit=30", headers })).json().rows.find((row: { title: string }) => row.title === "长篇制作记录").body.length, 800_000);
});

test("过期候选快照由原维护入口有界回收，当前草案、原情报与正式历史不变", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T16:00:00Z") });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", current = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  const studio = serverModules().find(module => module.name === "studio")!;
  const result = await studio.retention!(new Date("2026-10-21T16:00:00Z"));
  assert.ok(typeof result.studioTopicPreviewsRemoved === "number" && result.studioTopicPreviewsRemoved >= 1, "已截止超过48小时的临时候选不长期复制正文");
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), current);
  t.mock.timers.setTime(new Date("2026-10-17T12:00:00Z").getTime());
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "not_generated");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json().total, 3);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, 0); assert.equal(provider.hits(), calls);
});

test("候选初筛等共享模型位期间跨截止，获位后也不发送旧窗口收费请求", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "等待中的新镜头检查", url: "https://preview.example/waiting-slot", via: "import",
    discoveredAt: new Date("2026-10-22T12:30:00Z"), bodyText: "镜头检查需要新的参考样本，不能以旧样本保证结果。", bodyStatus: "ok" });
  const hold = { entered: gate(), release: gate(), count: 0 }; heldRequests = hold;
  const options = { model: "default", purpose: "preview_slot_guard", promptVersion: "preview-slot-guard-v1", system: "占用本地替身的模型执行位",
    schema: z.object({ ok: z.literal(true) }), maxTokens: 512 };
  const calls = [chatJson({ ...options, subject: "preview-held-one", user: '{"hold":"one"}' }), chatJson({ ...options, subject: "preview-held-two", user: '{"hold":"two"}' })];
  for (const call of calls) void call.catch(() => {});
  let waiting: Promise<unknown> | undefined;
  try {
    await Promise.race([hold.entered.promise, delay(4000).then(() => { throw new Error("两个模型位未进入受控请求"); })]);
    const before = provider.hits(), endpoint = "/api/admin/studio/topic-batches/current/preview";
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { startsAt: "2026-10-22T12:00:00.000Z" } });
    assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true);
    const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
    assert.ok(job); waiting = queue.run([job.data] as never[]); void waiting.catch(() => {});
    await expect.poll(async () => (await app.inject({ url: endpoint, headers })).json().state).toBe("running");
    await delay(300); assert.equal(provider.hits(), before, "两个执行位已占用，候选应等候而非发请求");
    t.mock.timers.setTime(new Date("2026-10-24T12:00:00Z").getTime());
    hold.release.open(); await Promise.all(calls); await waiting; await boss.complete(queue.name, job.id);
    assert.equal(provider.hits(), before, "跨截止后取得空位也不允许旧材料分析付费");
    assert.equal((await app.inject({ url: endpoint, headers })).json().state, "not_generated");
  } finally { hold.release.open(); await Promise.allSettled([...calls, ...(waiting ? [waiting] : [])]); heldRequests = undefined; }
});

test("更换模型配置使旧候选明确等待更新而非永久排队，显式更新能按新配置重新提交", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  await upsertMaterial({ sourceId: "topic-preview-news", title: "模型切换前的新制作说明", url: "https://preview.example/model-change", via: "import",
    discoveredAt: new Date("2026-10-24T12:30:00Z"), bodyText: "新流程仍需对照角色参考，不保证运动镜头效果。", bodyStatus: "ok" });
  const endpoint = "/api/admin/studio/topic-batches/current/preview", payload = { startsAt: "2026-10-24T12:00:00.000Z" };
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().queued, true);
  const original = (await app.inject({ url: endpoint, headers })).json(), calls = provider.hits();
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.topic.preview")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job);
  const saved = await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: { version: 0,
    baseUrl: "https://api.deepseek.com/v1", apiKey: "local-preview-model-change-key", analysisModel: "deepseek-flash", qualityModel: "deepseek-v4-pro" } });
  assert.equal(saved.statusCode, 200); assert.equal(provider.hits(), calls);
  try {
    await assert.doesNotReject(queue.run([job.data] as never[])); await boss.complete(queue.name, job.id);
    const stale = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(stale.state, "failed"); assert.equal(stale.stale, true); assert.match(stale.error, /模型.*变化|模型.*变更/);
    assert.equal(stale.version, original.version); assert.equal(stale.capturedAt, original.capturedAt); assert.equal(provider.hits(), calls);
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, retryFailed: true } })).statusCode, 409);
    t.mock.timers.setTime(new Date("2026-10-24T13:30:00Z").getTime());
    const updated = await app.inject({ method: "POST", url: endpoint, headers, payload }); assert.equal(updated.statusCode, 200); assert.equal(updated.json().queued, true);
    const fresh = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(fresh.version, original.version + 1); assert.equal(fresh.stale, false); assert.equal(fresh.state, "queued"); assert.notEqual(fresh.capturedAt, original.capturedAt);
    const [newJob] = await boss.fetch(queue.name); assert.ok(newJob); await boss.cancel(queue.name, newJob.id);
    assert.equal(provider.hits(), calls, "配置变动与排队均不实际访问官方服务或付费");
  } finally { await boss.cancel(queue.name, job.id); }
});
