import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Explicit local model fixture, never a production default.
const inputs: Array<any> = [];
const provider = await stub((_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content); inputs.push(input);
  const dimensions = { audience: 90, practical: 90, evidence: 90, freshness: 80, demand: null, distinctiveness: 80 }, gates = { audience: true, evidence: true, benefit: true };
  const result = input.task === "review_packet" ? { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: [] }
    : input.task === "review_summary" ? { passed: true, opinionIds: [], summary: "依据已覆盖，保留条件与限制" }
    : input.material ? { columnId: "practice", disposition: "support", summary: "先对照角色与光线", reason: "有操作与限制", viewerBenefit: "减少镜头返工", event: "镜头对照", evidenceQuotes: [input.material.body], dimensions, gates, entities: [] }
    : { directions: [{ id: "combined-reference", columnId: "practice", eventKey: "combined-reference", question: "如何同时检查角色与光线", viewerBenefit: "两步检查镜头一致性", whyNow: "补充了光线条件", angle: "先角色后光线",
      usage: { steps: ["固定参考角色", "核对光线条件"], conditions: ["同场景镜头"], limitations: ["运动镜头需实测"] },
      titles: ["角色与光线如何一起检查", "两步核对镜头一致性", "先角色再光线"], preferredTitle: 0, structure: { opening: "指出返工问题", rhythm: "演示两步", ending: "说明限制" }, dimensions, gates,
      references: input.materials.map(({ material }: { material: { id: string; body: string } }) => ({ materialId: material.id, role: "fact", quote: material.body, reason: "操作依据" })) }],
      assignments: input.materials.map(({ material }: { material: { id: string } }) => ({ materialId: material.id, columnId: "practice", disposition: "support", directionIds: ["combined-reference"], reason: "支撑对照" })) };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 30 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "local-supplement-fixture-key", LLM_MODEL: "local-supplement-fixture" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("指定栏目批选全库材料形成独立选题版本，去重重试不重建，来源更正不改变新旧冻结依据", async t => {
  config.modelCallsEnabled = false;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "supplement-news", name: "制作素材来源", kind: "rss", config: { feedUrl: "https://supplement.example/feed" } } })).statusCode, 200);
  const source = { sourceId: "supplement-news", via: "import" as const, bodyStatus: "ok" as const };
  await upsertMaterial({ ...source, title: "原批次角色方法", url: "https://supplement.example/original", discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "先固定参考角色，再逐镜检查。" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); const parentId = frozen.json().batch.id;
  const original = (await app.inject({ url: `/api/admin/studio/topic-batches/${parentId}/materials`, headers })).json();
  const extraInput = { ...source, title: "补充光线对照", url: "https://supplement.example/extra", discoveredAt: new Date("2026-10-18T12:00:00Z") };
  const extra = await upsertMaterial({ ...extraInput, bodyText: "先统一光线条件，复杂运动需单独验证。" }), materialId = "news:" + extra.articleId;
  const endpoint = `/api/admin/studio/topic-batches/${parentId}/supplements`, payload = { columnId: "practice", materialIds: [materialId, materialId] };
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload })).statusCode, 401);
  const created = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(created.statusCode, 200, created.body); assert.equal(created.json().created, true);
  const id = created.json().batchId; assert.notEqual(id, parentId);
  const materials = (await app.inject({ url: `/api/admin/studio/topic-batches/${id}/materials`, headers })).json();
  assert.equal(materials.total, 2); assert.equal(materials.rows.filter((row: { id: string }) => row.id === materialId).length, 1);
  assert.deepEqual(materials.rows.find((row: { id: string }) => row.id === materialId).suggestedColumnIds, ["practice"]);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${id}`, headers })).json().batch.materialCount, 2);
  const repeat = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(repeat.statusCode, 200); assert.equal(repeat.json().created, false); assert.equal(repeat.json().batchId, id);
  await upsertMaterial({ ...extraInput, bodyText: "后续更正：原来的光线方法需调整。" });
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${parentId}/materials`, headers })).json(), original);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${id}/materials`, headers })).json(), materials);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json().total, 1, "补充不提前占用下一期的自然采集归属");
});

test("未启用模型时补充保留，恢复后自动沿原队列完成分析选题审核；再次补充不改变已采纳稿件", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T13:00:00Z") });
  config.modelCallsEnabled = true; await resources.warm();
  const list = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json(), revised = list.rows.find((row: { revision: number }) => row.revision === 2), id = revised.id;
  const studio = serverModules().find(module => module.name === "studio")!, boss = await getBoss();
  await studio.schedules!.find(schedule => schedule.name === "studio.topic.material-analysis.schedule")!.run();
  const analysis = (await app.inject({ url: `/api/admin/studio/topic-batches/${id}/analysis`, headers })).json();
  assert.equal(analysis.rows.filter((row: { state: string }) => row.state === "queued").length, 2, "恢复模型后补充版本无需再次手动发起");
  for (const name of ["studio.topic.material-analysis", "studio.topic.generate", "studio.topic.review"]) {
    if (name !== "studio.topic.material-analysis") await studio.schedules!.find(schedule => schedule.name === (name === "studio.topic.generate" ? "studio.topic.generate.schedule" : "studio.topic.review.schedule"))!.run();
    const queue = studio.queues!.find(queue => queue.name === name)!;
    const jobs = await boss.fetch(name, { batchSize: 20 });
    assert.ok(jobs.some(job => (job.data as { batchId?: string }).batchId === id));
    for (const job of jobs) { await queue.run([job.data] as never[]); await boss.complete(name, job.id); }
  }
  const review = (await app.inject({ url: `/api/admin/studio/topic-batches/${id}/review`, headers })).json();
  assert.equal(review.state, "completed"); assert.equal(review.result.assignments.length, 2);
  assert.ok(inputs.some(input => input.material?.suggestedColumnIds?.includes("practice")), "指定栏目提示实际进入材料判断");
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: id, directionIds: ["combined-reference"] } });
  assert.equal(created.statusCode, 200, created.body); const draftPath = `/api/admin/studio/drafts/${created.json().id}`, before = (await app.inject({ url: draftPath, headers })).json();
  const extra = await upsertMaterial({ sourceId: "supplement-news", title: "再补充操作条件", url: "https://supplement.example/third", via: "import", bodyStatus: "ok", bodyText: "固定镜头才可使用，运动场景需另测。" });
  const next = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${revised.rootBatchId}/supplements`, headers, payload: { columnId: "practice", materialIds: ["news:" + extra.articleId] } });
  assert.equal(next.statusCode, 200, next.body); assert.notEqual(next.json().batchId, id);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${next.json().batchId}/materials`, headers })).json().total, 3, "从旧页面补充仍累积最新材料，不丢前次补充");
  assert.deepEqual((await app.inject({ url: draftPath, headers })).json(), before);
});

test("收集中的当期可补充已归往期的材料，重复不增，截止自动带入本期而不改往期归属", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T14:00:00Z") }); config.modelCallsEnabled = false; await resources.warm();
  const history = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json();
  const root = history.rows.find((row: { revision: number }) => row.revision === 1);
  const original = (await app.inject({ url: `/api/admin/studio/topic-batches/${root.id}/materials`, headers })).json();
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  const endpoint = "/api/admin/studio/topic-batches/current/supplements", payload = { startsAt: current.startsAt, columnId: "practice", materialIds: [original.rows[0].id] };
  const added = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json().total, current.materialCount + 1);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).json().changed, false);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json().materialCount, current.materialCount + 1);
  t.mock.timers.setTime(new Date("2026-10-20T12:00:00Z").getTime());
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: current.startsAt } });
  assert.equal(frozen.statusCode, 200, frozen.body); assert.equal(frozen.json().batch.materialCount, current.materialCount + 1);
  const saved = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers })).json();
  assert.deepEqual(saved.rows.find((row: { id: string }) => row.id === original.rows[0].id).suggestedColumnIds, ["practice"]);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${root.id}/materials`, headers })).json(), original);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409, "旧页面不能向下一期隐式补充");
});

test("当期栏目补充在模型恢复后自动更新候选，调度重跑不重复提交模型任务", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T13:00:00Z") }); config.modelCallsEnabled = false; await resources.warm();
  const first = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().rows.find((row: { startsAt: string; revision: number }) => row.startsAt === "2026-10-16T12:00:00.000Z" && row.revision === 1);
  const materialId = (await app.inject({ url: `/api/admin/studio/topic-batches/${first.id}/materials`, headers })).json().rows[0].id;
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches/current/supplements", headers, payload: { startsAt: window.startsAt, columnId: "practice", materialIds: [materialId] } })).statusCode, 200);
  const studio = serverModules().find(module => module.name === "studio")!, schedule = studio.schedules!.find(schedule => schedule.name === "studio.topic.supplements.schedule");
  assert.ok(schedule, "栏目补充必须有独立于网页打开的后台续接");
  await schedule.run(); assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/preview", headers })).json().state, "not_generated");
  config.modelCallsEnabled = true; await schedule.run();
  const pending = (await app.inject({ url: "/api/admin/studio/topic-batches/current/preview", headers })).json(); assert.equal(pending.state, "queued");
  await schedule.run();
  const boss = await getBoss(), queue = studio.queues!.find(queue => queue.name === "studio.topic.preview")!, jobs = await boss.fetch(queue.name, { batchSize: 10 });
  assert.equal(jobs.length, 1); await queue.run([jobs[0]!.data] as never[]); await boss.complete(queue.name, jobs[0]!.id);
  const result = (await app.inject({ url: "/api/admin/studio/topic-batches/current/preview", headers })).json(); assert.equal(result.state, "draft"); assert.equal(result.includedMaterialCount, 1);
  const calls = provider.hits(); await schedule.run(); assert.equal(provider.hits(), calls);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/preview", headers })).json().version, pending.version);
});

test("批量链接离开页面后仍按指定期次补充，跨截止不转下一期，部分失败可逐条重试", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-21T12:00:00Z") }); config.modelCallsEnabled = false;
  const collection = process.env.COLLECT_ENABLED; process.env.COLLECT_ENABLED = "false";
  t.after(() => { process.env.COLLECT_ENABLED = collection; });
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  const endpoint = "/api/admin/studio/topic-supplement-imports";
  const payload = { startsAt: current.startsAt, columnId: "practice", links: [
    { kind: "news", url: "https://supplement.example/extra" }, { kind: "news", url: "https://supplement.example/late-link" },
  ] };
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload })).statusCode, 401);
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.equal(submitted.statusCode, 200, submitted.body); assert.equal(submitted.json().rows.length, 2);
  const ids = submitted.json().rows.map((row: { id: string }) => row.id);
  const duplicate = await app.inject({ method: "POST", url: endpoint, headers, payload });
  assert.deepEqual(duplicate.json().rows.map((row: { id: string }) => row.id), ids);
  t.mock.timers.setTime(new Date("2026-10-22T12:00:00Z").getTime());
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: current.startsAt } });
  assert.equal(frozen.statusCode, 200, frozen.body); const rootId = frozen.json().batch.id;
  const oldMaterials = (await app.inject({ url: `/api/admin/studio/topic-batches/${rootId}/materials`, headers })).json();
  const studio = serverModules().find(module => module.name === "studio")!;
  const schedule = studio.schedules!.find(schedule => schedule.name === "studio.topic.supplement-imports.schedule"); assert.ok(schedule);
  await schedule.run();
  const read = () => app.inject({ url: `${endpoint}?startsAt=${encodeURIComponent(current.startsAt)}&columnId=practice`, headers });
  const rows = (await read()).json().rows;
  assert.equal(rows.find((row: { id: string }) => row.id === ids[0]).state, "applied");
  assert.equal(rows.find((row: { id: string }) => row.id === ids[1]).state, "failed", "未开启采集的未知链接单独提示，不吞掉成功项");
  const revisedId = rows.find((row: { id: string }) => row.id === ids[0]).resultBatchId;
  assert.notEqual(revisedId, rootId);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${revisedId}`, headers })).json().batch.startsAt, current.startsAt);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${rootId}/materials`, headers })).json(), oldMaterials);
  await upsertMaterial({ sourceId: "supplement-news", title: "迟到链接的操作条件", url: payload.links[1]!.url, via: "import", bodyStatus: "ok", bodyText: "镜头相同后再逐步核对运镜。" });
  const nextBefore = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json();
  const retry = await app.inject({ method: "POST", url: `${endpoint}/${ids[1]}/retry`, headers, payload: {} });
  assert.equal(retry.statusCode, 200, retry.body); await schedule.run();
  assert.equal((await read()).json().rows.find((row: { id: string }) => row.id === ids[1]).state, "applied");
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json(), nextBefore, "补充不抢占或改变下一期自然材料");
  const completed = (await read()).json(); await schedule.run(); assert.deepEqual((await read()).json(), completed);
});

test("视频补充等待真实转写，恢复媒体开关后续接原队列，转写失败可逐条重试而不把简介当正文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); config.modelCallsEnabled = false;
  const previous = getGlobalDispatcher(), transport = new MockAgent(), collect = process.env.COLLECT_ENABLED, media = process.env.STUDIO_MEDIA_ENABLED;
  const privateFetch = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  transport.disableNetConnect(); setGlobalDispatcher(transport); process.env.COLLECT_ENABLED = "true"; process.env.STUDIO_MEDIA_ENABLED = "false";
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); config.allowPrivateNetworkFetch = privateFetch; process.env.COLLECT_ENABLED = collect; process.env.STUDIO_MEDIA_ENABLED = media; });
  const window = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  const endpoint = "/api/admin/studio/topic-supplement-imports", payload = { startsAt: window.startsAt, columnId: "practice", links: [{ kind: "creator", url: "https://www.bilibili.com/video/BV1supplementfixture" }] };
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload }); assert.equal(submitted.statusCode, 200, submitted.body);
  const id = submitted.json().rows[0].id, read = async () => (await app.inject({ url: `${endpoint}?startsAt=${encodeURIComponent(window.startsAt)}&columnId=practice`, headers })).json().rows.find((row: { id: string }) => row.id === id);
  const studio = serverModules().find(module => module.name === "studio")!, schedule = studio.schedules!.find(schedule => schedule.name === "studio.topic.supplement-imports.schedule")!;
  await schedule.run(); assert.equal((await read()).state, "reading");
  const api = transport.get("https://api.bilibili.com");
  api.intercept({ path: /^\/x\/web-interface\/view\/detail\?/ }).reply(200, { code: 0, data: { View: { aid: 12345, bvid: "BV1supplementfixture", title: "镜头检查视频", desc: "只是简介，不能当作完整转写。", owner: { mid: 20813884, name: "镜头流程研究" }, pages: [{ cid: 666 }], stat: { view: 12000 }, pubdate: 1792231200 } } });
  api.intercept({ path: "/x/web-interface/nav" }).reply(200, { code: 0, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  api.intercept({ path: /^\/x\/player\/wbi\/playurl\?/ }).reply(200, { code: 0, data: { durl: [{ url: "https://upos-sz.example.bilivideo.com/fixture.mp4", size: 1000 }] } });
  api.intercept({ path: /^\/x\/player\/wbi\/v2\?/ }).reply(200, { code: 0, data: { subtitle: { subtitles: [] } } });
  const boss = await getBoss(), queue = studio.queues!.find(queue => queue.name === "studio.content.import")!, [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); await schedule.run();
  const waiting = await read(); assert.equal(waiting.state, "waiting_transcript");
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  process.env.STUDIO_MEDIA_ENABLED = "true"; await schedule.run();
  const [processing] = await boss.fetch("studio.media.process"); assert.ok(processing, "恢复媒体许可后须补排原转写任务，无需重导入平台作品");
  await boss.cancel("studio.media.process", processing.id); await schedule.run();
  assert.equal((await read()).state, "failed");
  assert.equal((await app.inject({ method: "POST", url: `${endpoint}/${id}/retry`, headers, payload: {} })).statusCode, 200);
  await schedule.run(); assert.equal((await read()).state, "waiting_transcript");
  const retried = await boss.fetch("studio.media.process"); assert.equal(retried.length, 1);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${waiting.materialId}`, headers })).json().bodyState, "not_transcribed");
  transport.assertNoPendingInterceptors();
});
