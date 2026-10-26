import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, mock, type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss, workModuleQueues, QueueDeferred, ensureQueue } from "@aihot/backend/jobs/queue";
import { installModules, serverModules } from "@aihot/backend/modules";
import { createModelAdmission } from "../backend/model-admission.ts";
import { setTimeout as delay } from "node:timers/promises";
import { stub, gate, Reply } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";
import { topicReviewQueue } from "../backend/topic-review.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { weiboFixture } from "./mediacrawler-fixture.ts";
import type { WritingProject } from "../contracts.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Controlled localhost model and media fixtures in this isolated test process.
// This file drives hundreds of local model-stub steps; timing must not determine its request allowance.
assert.equal((await app.inject({ method: "PUT", url: "/api/admin/budgets/llm", headers,
  payload: { perMinute: 10000, perHour: 10000, perDay: 10000, reason: "local writing regression fixture" } })).statusCode, 200);
const body = "先固定参考图，再逐镜检查角色与光线；效果尚未亲测，不能保证消除所有漂移。";
let caseNumber = 0;
const writingRequests: Array<{ task: string; [key: string]: unknown }> = [];
const styleRequests: Array<{ task: string; [key: string]: unknown }> = [];
let holdGeneration: ReturnType<typeof gate<void>> | undefined, generationStarted: ReturnType<typeof gate<void>> | undefined;
let checkHasProblems = false;
let pauseAfterTask: string | undefined;
let styleCheckFails = false;
let styleDuringTrial: (() => Promise<void>) | undefined;
let styleRuleBody = "先用具体制作问题开头，演示后说明适用条件。";
let styleProviderFails = false;
let stylePauseAfterTask: string | undefined;
let chooseAvailableImages = false;
let generatedImageMarkup = "";
let generatedSpokenOverride: string | undefined;
let newsImageBrowserCase: { batchId: string; generatedId: string; sourceUrl: string; articleUrl: string; assetId: string };
const spoken = "角色在两个镜头里总是变脸，可以先检查参考图有没有固定。" + "先准备角色参考图，再逐镜检查角色与光线。这个方法适合已经有角色图的制作流程；来源说明尚未亲测，不能保证消除所有漂移。可以先用两个镜头对照，确认条件一致，再考虑用在更多分镜中。".repeat(5);
const revisionText = "先固定参考图，再用两个镜头检查人物与光线，效果仍需自己核对。";
const provider = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  let result: unknown;
  if (input.task?.startsWith("writing_")) {
    const generatedSpoken = generatedSpokenOverride ?? spoken;
    writingRequests.push(input);
    if (input.task === pauseAfterTask) {
      const current = (await app.inject({ url: "/api/admin/studio/model-operations", headers })).json();
      assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers,
        payload: { version: current.version, enabled: false } })).statusCode, 200);
    }
    if (input.task === "writing_draft") { generationStarted?.open(); await holdGeneration?.promise; }
    if (input.task === "writing_revision") result = { replacement: revisionText, reason: "用具体动作替代空泛表述，并保留未验证条件", facts: [{ materialId: input.project.snapshot.materials[0].id, quote: body, claim: "固定参考后逐镜检查，尚未亲测" }] };
    else if (input.task === "writing_revision_check") result = { passed: true, issues: [] };
    else if (["writing_polish", "writing_repair"].includes(input.task)) result = { spoken: generatedSpoken };
    else if (["writing_check", "writing_check_repaired"].includes(input.task)) result = { passed: true,
      issues: checkHasProblems ? [{ severity: "major", problem: "标题承诺仍需人工核对", suggestion: "核对标题中的效果是否有来源支撑" }] : [] };
    else result = { content: { spoken: generatedSpoken, production: "先录屏展示角色参考图，再录两个镜头的对照，保留未验证的限制。", notes: "需要实际录屏演示，尚未进行效果实测。" + generatedImageMarkup },
      facts: [{ materialId: input.snapshot.materials[0].id, quote: body, claim: "先固定参考图，再逐镜检查，效果未亲测" }],
      expressionReferences: [], shots: [{ startSeconds: 0, endSeconds: 120, visual: "参考图与连续镜头录屏", captureMethod: "screen_recording",
        assetIds: chooseAvailableImages && input.availableImages?.length ? [input.availableImages[0].assetId] : [] }] };
  }
  else if (input.creator) result = { patterns: [{ dimension: "opening", observation: "先指出具体镜头问题", application: "用本题的制作问题开场",
    possibleEffect: "可能便于辨认问题，未验证流量因果", limitations: "只有文字依据", evidence: input.materials.map((material: { id: string }) => ({ materialId: material.id, quote: "先固定参考图" })) }] };
  else if (input.task?.startsWith("style_")) {
    styleRequests.push(input);
    if (input.task === stylePauseAfterTask) {
      const current = (await app.inject({ url: "/api/admin/studio/model-operations", headers })).json();
      assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers,
        payload: { version: current.version, enabled: false } })).statusCode, 200);
    }
    if (input.task === "style_trial_0" && styleProviderFails) return new Reply(503, { error: "external style fixture unavailable" });
    if (input.task === "style_trial_0" && styleDuringTrial) { const change = styleDuringTrial; styleDuringTrial = undefined; await change(); }
    if (input.task === "style_candidate") result = { summary: "从确认稿提取问题、演示和限制的表达习惯", rules: [{ key: "opening", body: styleRuleBody,
      evidence: [{ projectId: input.training[0].projectId, version: input.training[0].version, quote: input.training[0].spoken }] }] };
    else if (input.task.startsWith("style_compare_")) result = { checks: ["facts", "attribution", "conditions", "experience", "title", "readability", "templates", "duration"].map(criterion => ({
      criterion, baselinePass: criterion !== "templates", candidatePass: !(styleCheckFails && criterion === "facts"), reason: criterion === "templates" ? "候选移除泛泛的聊聊开场" : "检查来源条件与朗读要求",
      baselineQuote: "今天我们来聊聊", candidateQuote: "角色在两个镜头里总是变脸", materialId: input.prompt.materials[0].id, sourceQuote: body })) };
    else result = { spoken: input.task.startsWith("style_baseline_") ? "今天我们来聊聊。" + spoken : spoken };
  }
  else if (input.task === "review_packet") result = { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: [] };
  else if (input.task === "review_summary") result = { passed: true, opinionIds: [], summary: "操作与限制清楚" };
  else if (input.material) result = { columnId: "practice", disposition: "support", summary: "角色参考流程", reason: "有步骤与限制", viewerBenefit: "减少返工",
    event: "角色参考", evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 } };
  else {
    const materialId = input.materials[0].material.id;
    result = { directions: ["reference", "lighting"].map(id => ({ id, columnId: "practice", eventKey: id,
      question: id === "reference" ? "角色变脸怎么办" : "跨镜头光线怎么检查", viewerBenefit: "知道逐镜检查的方法和限制", whyNow: "新的制作说明", angle: "用具体场景演示",
      usage: { steps: ["固定参考图", "逐镜检查"], conditions: ["有角色图"], limitations: ["尚未亲测"] },
      titles: [id === "reference" ? "角色参考怎么用" : "镜头光线怎么检查", "两步检查镜头一致性", "先看清适用条件"], preferredTitle: 0,
      structure: { opening: "给出问题", rhythm: "演示再解释", ending: "说明限制" }, references: [{ materialId, role: "fact", quote: body, reason: "原始步骤" }],
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 80, practical: 80, evidence: 80, freshness: 80, demand: null, distinctiveness: 80 },
    })), assignments: [{ materialId, columnId: "practice", disposition: "support", directionIds: ["reference", "lighting"], reason: "操作依据" }] };
  }
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "writing-fixture-key", LLM_MODEL: "writing-fixture-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

async function reviewedBatch(t: TestContext, sourceImageUrl?: string) {
  const start = new Date(Date.parse("2026-10-16T12:00:00Z") + caseNumber++ * 48 * 3600_000);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start.getTime() + 48 * 3600_000) });
  await resources.warm(); config.modelCallsEnabled = true;
  const sourceId = `writing-source-${caseNumber}`, url = `https://writing-${caseNumber}.example/one`;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: sourceId, name: "制作流程原始来源", kind: "rss", config: { feedUrl: `https://writing-${caseNumber}.example/rss` } } })).statusCode, 200);
  const material = await upsertMaterial({ sourceId, title: "角色与光线检查", url, via: "import", discoveredAt: new Date(start.getTime() + 3600_000), publishedAt: start, bodyText: body, bodyStatus: "ok",
    ...(sourceImageUrl ? { media: [{ kind: "image" as const, url: sourceImageUrl, alt: "隔离测试：角色参考图设置" }] } : {}) });
  if (sourceImageUrl) {
    const endpoint = `/api/admin/studio/intelligence/news:${material.articleId}/images`, pending = (await app.inject({ url: endpoint, headers })).json();
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { versionKey: pending.versionKey } })).statusCode, 200);
    const { sourceImagesQueue } = await import("../backend/source-images.ts"), boss = await getBoss(), [job] = await boss.fetch(sourceImagesQueue.name);
    assert.ok(job); await sourceImagesQueue.run([job.data] as never[]); await boss.complete(sourceImagesQueue.name, job.id);
    assert.equal((await app.inject({ url: endpoint, headers })).json().state, "ready");
  }
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: start.toISOString() } });
  assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id, prefix = `/api/admin/studio/topic-batches/${batchId}`, boss = await getBoss();
  for (const [suffix, queue] of [["analysis", topicAnalysisQueue], ["recommendations", topicGenerationQueue], ["review", topicReviewQueue]] as const) {
    const response = await app.inject({ method: "POST", url: prefix + "/" + suffix, headers, payload: {} });
    assert.equal(response.statusCode, 200, `${suffix}: ${response.body}`);
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  }
  return { batchId, sourceId, url, materialId: "news:" + material.articleId };
}

async function confirmStyleSamples(batchId: string, tag: string, withoutFacts = false) {
  for (let index = 0; index < 5; index++) {
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId, directionIds: ["reference"], title: `${tag}${index + 1}`, ...(withoutFacts ? { references: [] } : {}) } });
    assert.equal(created.statusCode, 200); const url = "/api/admin/studio/drafts/" + created.json().id;
    assert.equal((await app.inject({ method: "PATCH", url, headers,
      payload: { version: 1, content: { spoken: `${tag}${index + 1}：先展示实际镜头问题，再说明操作和适用条件，尚未亲测。`, production: "录屏", notes: "" } } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: url + "/finalize", headers, payload: { version: 2 } })).statusCode, 200);
  }
}

async function runStyleLearning() {
  const url = "/api/admin/studio/columns/practice/learning";
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true);
  const { styleLearningQueue } = await import("../backend/style-learning.ts"), boss = await getBoss(), [job] = await boss.fetch(styleLearningQueue.name);
  assert.ok(job); await styleLearningQueue.run([job.data] as never[]); await boss.complete(styleLearningQueue.name, job.id);
  return (await app.inject({ url, headers })).json().run;
}

test("全域稿件搜索跨期按标题正文和冻结来源检索，模糊匹配且不把通配符当条件", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/drafts";
  const created = await app.inject({ method: "POST", url: endpoint, headers, payload: {
    requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "搜索验证：跨镜头角色一致性", } });
  assert.equal(created.statusCode, 200); const id = created.json().id;
  const saved = await app.inject({ method: "PATCH", url: `${endpoint}/${id}`, headers,
    payload: { version: 1, content: { spoken: "独特关键词：人物参考的光线衔接，以及100%完成不代表效果保证。", production: "", notes: "" } } });
  assert.equal(saved.statusCode, 200);
  const project = (await app.inject({ url: `${endpoint}/${id}`, headers })).json();
  for (const q of ["角色一致", "光线衔接", project.snapshot.materials[0].source.name, "100%完成"]) {
    const result = await app.inject({ url: endpoint + "?q=" + encodeURIComponent(q), headers });
    assert.equal(result.statusCode, 200, result.body); assert.ok(result.json().rows.some((row: {id:string}) => row.id === id), q);
  }
  const escaped = await app.inject({ url: endpoint + "?q=" + encodeURIComponent("%_不存在"), headers });
  assert.equal(escaped.statusCode, 200); assert.equal(escaped.json().total, 0);
  assert.equal((await app.inject({ url: endpoint + "?q=角色" })).statusCode, 401);
});

test("同批次可采纳多个方向或明确组合成三篇独立稿件，重复提交幂等，历史资料与规则快照不变", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/drafts";
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  const requestId = randomUUID(), input = { requestId, batchId: batch.batchId, directionIds: ["reference"], title: "角色参考的实际用法",
    instructions: "对新手讲清限制", references: [{ materialId: batch.materialId, role: "fact" }] };
  const first = await app.inject({ method: "POST", url: endpoint, headers, payload: input });
  assert.equal(first.statusCode, 200); const firstId = first.json().id; assert.ok(firstId);
  const second = await app.inject({ method: "POST", url: endpoint, headers, payload: { ...input, requestId: randomUUID(), directionIds: ["lighting"], title: "跨镜头光线的检查方法" } });
  const third = await app.inject({ method: "POST", url: endpoint, headers, payload: { ...input, requestId: randomUUID(), directionIds: ["reference", "lighting"], title: "角色和光线一起检查" } });
  assert.equal(second.statusCode, 200); assert.equal(third.statusCode, 200);
  assert.equal(new Set([firstId, second.json().id, third.json().id]).size, 3);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: input })).json().id, firstId);
  assert.equal((await app.inject({ url: endpoint, headers })).json().total, 3);
  const original = await app.inject({ url: endpoint + "/" + firstId, headers });
  assert.equal(original.headers["cache-control"], "no-store");
  const saved = original.json(); assert.equal(saved.title, input.title); assert.equal(saved.instructions, input.instructions);
  assert.equal(saved.snapshot.directions.length, 1); assert.equal(saved.snapshot.materials[0].body, body);
  assert.ok(saved.snapshot.audience.includes("关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验"));
  await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 2, name: "后来改名的栏目" } });
  await upsertMaterial({ sourceId: batch.sourceId, title: "来源已更正", url: batch.url, via: "import", bodyText: "来源已更正并换正文", bodyStatus: "ok" });
  assert.deepEqual((await app.inject({ url: endpoint + "/" + firstId, headers })).json().snapshot, saved.snapshot);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}`, headers })).json().batch.adoptionState, "adopted");
  const adoption = (await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}`, headers })).json().batch;
  assert.equal(adoption.selectionState, "adopted"); assert.equal(adoption.finalizedDraftCount, 0);
  assert.deepEqual(adoption.adoptedDirectionIds.toSorted(), ["lighting", "reference"]);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches?q=" + encodeURIComponent(input.title), headers })).json().rows[0].id, batch.batchId);
});

test("手动和自动保存绑定具体稿件与版本，另一窗口的旧版本不能覆盖，未改内容不堆积历史", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/drafts";
  const create = async (title: string) => (await app.inject({ method: "POST", url: endpoint, headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title } })).json().id;
  const first = await create("第一篇独立稿"), second = await create("第二篇独立稿");
  const content = { spoken: "先看角色参考图。接下来逐镜检查；没有亲测，不承诺所有镜头都有效。", production: "录屏展示参考图和两个镜头对照。", notes: "补拍验证画面" };
  const saved = await app.inject({ method: "PATCH", url: endpoint + "/" + first, headers, payload: { version: 1, mode: "manual", content } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().version, 2);
  const stale = await app.inject({ method: "PATCH", url: endpoint + "/" + first, headers,
    payload: { version: 1, mode: "auto", content: { ...content, spoken: "另一个窗口的过期正文" } } });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual((await app.inject({ url: endpoint + "/" + first, headers })).json().content, content);
  assert.equal((await app.inject({ url: endpoint + "/" + second, headers })).json().content.spoken, "");
  assert.equal((await app.inject({ method: "PATCH", url: endpoint + "/" + first, headers, payload: { version: 2, mode: "auto", content } })).json().version, 2);
  const original = await app.inject({ url: endpoint + "/" + first + "/versions/1", headers });
  assert.equal(original.statusCode, 200); assert.equal(original.json().content.spoken, ""); assert.equal(original.json().title, "第一篇独立稿");
  assert.equal((await app.inject({ url: endpoint + "/" + first + "/versions", headers })).json().total, 2);
});

test("默认中文去AI味规则与启用栏目Skill按版本固定到每稿，后续停用或改规则不改旧稿", async t => {
  const batch = await reviewedBatch(t), skillsUrl = "/api/admin/studio/writing-skills";
  assert.equal((await app.inject({ url: skillsUrl })).statusCode, 401);
  const defaults = (await app.inject({ url: skillsUrl, headers })).json();
  assert.ok(defaults.rows.some((skill: { id: string; enabled: boolean }) => skill.id === "humanizer-zh" && skill.enabled));
  const created = await app.inject({ method: "POST", url: skillsUrl, headers, payload: { name: "实操栏目说话习惯", body: "先给出操作步骤，保留适用条件。", columnIds: ["practice"], enabled: true, priority: 100 } });
  assert.equal(created.statusCode, 200); const skill = created.json();
  const create = async (title: string) => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title } })).json().id;
  const firstId = await create("按旧规则创建"), first = (await app.inject({ url: "/api/admin/studio/drafts/" + firstId, headers })).json();
  assert.ok(first.snapshot.skills.some((item: { id: string; body: string }) => item.id === "humanizer-zh" && item.body.includes("保留信息和确定程度")));
  assert.ok(first.snapshot.skills.some((item: { id: string; version: string; body: string }) => item.id === skill.id && item.version === "1" && item.body === "先给出操作步骤，保留适用条件。"));
  const changed = await app.inject({ method: "PATCH", url: skillsUrl + "/" + skill.id, headers, payload: { version: 1, enabled: false, body: "这是后来修改的新规则。" } });
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().version, 2);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/drafts/" + firstId, headers })).json().snapshot.skills, first.snapshot.skills);
  const secondId = await create("停用之后创建"), second = (await app.inject({ url: "/api/admin/studio/drafts/" + secondId, headers })).json();
  assert.ok(!second.snapshot.skills.some((item: { id: string }) => item.id === skill.id));
  assert.equal((await app.inject({ method: "PATCH", url: skillsUrl + "/" + skill.id, headers, payload: { version: 1, enabled: true } })).statusCode, 409);
  const restored = await app.inject({ method: "POST", url: skillsUrl + "/" + skill.id + "/restore", headers, payload: { version: 2, sourceVersion: 1 } });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().version, 3);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/drafts/" + firstId, headers })).json().snapshot.skills, first.snapshot.skills);
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/drafts/" + secondId, headers })).json().snapshot.skills, second.snapshot.skills);
  const third = (await app.inject({ url: "/api/admin/studio/drafts/" + await create("回退之后的新稿"), headers })).json();
  assert.ok(third.snapshot.skills.some((item: { id: string; version: string; body: string }) => item.id === skill.id && item.version === "3" && item.body === "先给出操作步骤，保留适用条件。"));
});

test("只改写作规则名称不应重新启用已停用规则或重置栏目与优先级", async () => {
  const endpoint = "/api/admin/studio/writing-skills";
  const created = await app.inject({ method: "POST", url: endpoint, headers,
    payload: { name: "停用的规则", body: "保持证据边界", enabled: false, priority: 20, columnIds: ["practice"] } });
  assert.equal(created.statusCode, 200); const id = created.json().id;
  const changed = await app.inject({ method: "PATCH", url: endpoint + "/" + id, headers, payload: { version: 1, name: "只更新了名称" } });
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().enabled, false);
  assert.equal(changed.json().priority, 20); assert.deepEqual(changed.json().columnIds, ["practice"]);
});

test("已采纳稿件在后台生成口播与制作方案，实际加载冻结Humanizer规则并核对事实，保存到本稿版本且读取不重复调用", async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "角色参考的条件与用法", instructions: "先讲条件，再给操作" } });
  assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `/api/admin/studio/drafts/${id}/generation`, firstCall = writingRequests.length;
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { version: 1 } });
  assert.equal(submitted.statusCode, 200); assert.ok(submitted.json().jobId);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  const generation = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(generation.state, "completed"); assert.equal(generation.quality, "checked"); assert.equal(generation.result.content.spoken, spoken);
  assert.ok(generation.result.content.production.includes("录屏")); assert.equal(generation.result.expressionReferences.length, 0);
  assert.equal(generation.result.duration.kind, "estimated"); assert.ok(generation.result.duration.seconds > 60);
  const saved = (await app.inject({ url: `/api/admin/studio/drafts/${id}`, headers })).json();
  assert.equal(saved.version, 2); assert.equal(saved.content.spoken, spoken); assert.equal(saved.title, "角色参考的条件与用法");
  const calls = writingRequests.slice(firstCall); assert.deepEqual(calls.map(call => call.task), ["writing_draft", "writing_polish", "writing_check"]);
  assert.ok(JSON.stringify(calls[1]).includes("保留信息和确定程度"));
  assert.ok(JSON.stringify(calls[0]).includes("先讲条件，再给操作"));
  await app.inject({ url: endpoint, headers }); await writingGenerationQueue.run([job.data] as never[]);
  assert.equal(writingRequests.length, firstCall + 3);
});

test("生成期间手改本稿时保留手动正文，迟到的AI结果保存为待采纳提案，不能覆盖本稿或其他稿", async t => {
  const batch = await reviewedBatch(t);
  const create = async (title: string) => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title } })).json().id;
  const firstId = await create("生成中的稿件"), secondId = await create("另一篇独立稿件"), endpoint = `/api/admin/studio/drafts/${firstId}/generation`;
  await app.inject({ method: "POST", url: endpoint, headers, payload: { version: 1 } });
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  holdGeneration = gate(); generationStarted = gate();
  const pending = writingGenerationQueue.run([job.data] as never[]); void pending.catch(() => {});
  try {
    await generationStarted.promise;
    const content = { spoken: "这是等待期间手动写下的正文。", production: "我的拍摄方案", notes: "不要自动覆盖" };
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${firstId}`, headers, payload: { version: 1, content } })).statusCode, 200);
    holdGeneration.open(); await pending; await boss.complete(writingGenerationQueue.name, job.id);
    const saved = (await app.inject({ url: `/api/admin/studio/drafts/${firstId}`, headers })).json();
    assert.equal(saved.version, 2); assert.deepEqual(saved.content, content);
    const result = (await app.inject({ url: endpoint, headers })).json(); assert.equal(result.state, "proposal"); assert.equal(result.result.content.spoken, spoken);
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${secondId}`, headers })).json().content.spoken, "");
  } finally { holdGeneration.open(); holdGeneration = undefined; generationStarted = undefined; await pending.catch(() => {}); }
});

test("待采纳AI稿只在用户指定当前版本后应用，不能跨稿件或覆盖再次编辑的版本，手动稿历史可保留", async t => {
  const batch = await reviewedBatch(t);
  const create = async () => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const id = await create(), otherId = await create(), endpoint = `/api/admin/studio/drafts/${id}/generation`;
  await app.inject({ method: "POST", url: endpoint, headers, payload: { version: 1 } });
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  holdGeneration = gate(); generationStarted = gate();
  const pending = writingGenerationQueue.run([job.data] as never[]); void pending.catch(() => {});
  try {
    await generationStarted.promise;
    await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${id}`, headers, payload: { version: 1, content: { spoken: "我的手改版", production: "", notes: "" } } });
    holdGeneration.open(); await pending; await boss.complete(writingGenerationQueue.name, job.id);
    const generation = (await app.inject({ url: endpoint, headers })).json(), calls = writingRequests.length;
    const apply = endpoint + "/" + generation.id + "/apply";
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${otherId}/generation/${generation.id}/apply`, headers, payload: { version: 1 } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: apply, headers, payload: { version: 1 } })).statusCode, 409);
    const applied = await app.inject({ method: "POST", url: apply, headers, payload: { version: 2 } });
    assert.equal(applied.statusCode, 200); assert.equal(applied.json().version, 3);
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${id}`, headers })).json().content.spoken, spoken);
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${id}/versions/2`, headers })).json().content.spoken, "我的手改版");
    await app.inject({ method: "POST", url: apply, headers, payload: { version: 3 } });
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${id}`, headers })).json().version, 3); assert.equal(writingRequests.length, calls);
  } finally { holdGeneration.open(); holdGeneration = undefined; generationStarted = undefined; await pending.catch(() => {}); }
});

test("缺少事实原稿时不花钱生成，关闭模型后仍能手动保存稿件", async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], references: [{ materialId: batch.materialId, role: "expression" }] } });
  assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `/api/admin/studio/drafts/${id}`, calls = writingRequests.length;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 409);
  assert.equal(writingRequests.length, calls);
  config.modelCallsEnabled = false;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: { spoken: "手动写下的稿件", production: "", notes: "需补来源" } } })).statusCode, 200);
  assert.equal((await app.inject({ url: endpoint, headers })).json().content.spoken, "手动写下的稿件");
  assert.equal(writingRequests.length, calls);
});

test("实际多步写稿连续两次暂停恢复不消耗失败重试，不重调已保存步骤并最终自动完成", { timeout: 25_000 }, async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200);
  const endpoint = `/api/admin/studio/drafts/${created.json().id}/generation`, first = writingRequests.length;
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const queue = { ...writingGenerationQueue, admission: createModelAdmission({ host: resources.host, disk: resources.disk, database: resources.database }) };
  const previousModules = serverModules();
  installModules(previousModules.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const boss = await getBoss(); let stop: (() => Promise<void>) | undefined, submittedId: string | undefined;
  const operationsUrl = "/api/admin/studio/model-operations";
  try {
    pauseAfterTask = "writing_draft";
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: { version: 1 } }); assert.equal(submitted.statusCode, 200);
    const id = submitted.json().jobId; submittedId = id;
    stop = await workModuleQueues(boss); await resources.warm();
    for (const [index, next] of ["writing_polish", undefined].entries()) {
      const deadline = performance.now() + 7000;
      while (performance.now() < deadline) {
        const job = (await boss.findJobs(queue.name, { id }))[0]!;
        const state = (await app.inject({ url: operationsUrl, headers })).json();
        if (!state.enabled && job.state === "created") break;
        await delay(30);
      }
      const waiting = (await boss.findJobs(queue.name, { id }))[0]!;
      assert.equal(waiting.state, "created", JSON.stringify(waiting.output)); assert.equal(waiting.retryCount, 0);
      assert.equal((await app.inject({ url: endpoint, headers })).json().state, "queued");
      assert.equal(writingRequests.length - first, index + 1);
      pauseAfterTask = next;
      const state = (await app.inject({ url: operationsUrl, headers })).json();
      assert.equal((await app.inject({ method: "PUT", url: operationsUrl, headers, payload: { version: state.version, enabled: true } })).statusCode, 200);
    }
    const deadline = performance.now() + 7000;
    while (performance.now() < deadline && (await boss.findJobs(queue.name, { id }))[0]!.state !== "completed") await delay(30);
    const finished = (await boss.findJobs(queue.name, { id }))[0]!;
    assert.equal(finished.state, "completed"); assert.equal(finished.retryCount, 0);
    assert.deepEqual(writingRequests.slice(first).map(call => call.task), ["writing_draft", "writing_polish", "writing_check"]);
    assert.equal((await app.inject({ url: endpoint, headers })).json().state, "completed");
  } finally {
    pauseAfterTask = undefined; await stop?.(); installModules(previousModules);
    if (submittedId) await boss.cancel(queue.name, submittedId);
    const state = (await app.inject({ url: operationsUrl, headers })).json();
    await app.inject({ method: "PUT", url: operationsUrl, headers, payload: { version: state.version, enabled: true } });
  }
});

test("事实对照存在重要问题时最多局部修订一次，仍有问题交付明确提醒，不能标成检查通过或无限重写", async t => {
  const batch = await reviewedBatch(t);
  const id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}/generation`, first = writingRequests.length;
  await app.inject({ method: "POST", url: endpoint, headers, payload: { version: 1 } });
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  checkHasProblems = true;
  try {
    await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
    const result = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(result.quality, "needs_attention"); assert.equal(result.result.issues[0].severity, "major");
    assert.deepEqual(writingRequests.slice(first).map(call => call.task), ["writing_draft", "writing_polish", "writing_check", "writing_repair", "writing_check_repaired"]);
    const overview = await app.inject({ url: "/api/admin/models?days=365", headers }); assert.equal(overview.statusCode, 200);
    assert.deepEqual(overview.json().capabilities.find((item: { key: string }) => item.key === "studioWriting").usage.map((item: { purpose: string }) => item.purpose).sort(),
      ["studio_writing_draft", "studio_writing_polish", "studio_writing_check", "studio_writing_repair", "studio_writing_check_repaired"].sort());
    await writingGenerationQueue.run([job.data] as never[]); assert.equal(writingRequests.length, first + 5);
  } finally { checkHasProblems = false; }
});

test("明确确认才成为定稿，之后手改与恢复历史创建新版本，既有定稿快照保留且旧窗口不能恢复覆盖", async t => {
  const batch = await reviewedBatch(t);
  const id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, content = { spoken: "这是我确认的口播稿。", production: "录屏逐镜检查", notes: "未实测效果" };
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 1 } })).statusCode, 409);
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } });
  const final = await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 2 } });
  assert.equal(final.statusCode, 200); assert.equal(final.json().state, "final"); assert.equal(final.json().version, 3);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 3 } })).json().version, 3);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}`, headers })).json().batch.finalizedDraftCount, 1);
  const modified = await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, content: { ...content, spoken: "后续修改，尚未定稿" } } });
  assert.equal(modified.json().state, "draft"); assert.equal(modified.json().version, 4);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}`, headers })).json().batch.finalizedDraftCount, 1, "后续编辑不抹去已经确认的历史定稿，也不重复计数");
  const snapshot = (await app.inject({ url: endpoint + "/versions/3", headers })).json();
  assert.equal(snapshot.source, "final"); assert.deepEqual(snapshot.content, content);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/restore", headers, payload: { version: 3, restoreVersion: 3 } })).statusCode, 409);
  const restored = await app.inject({ method: "POST", url: endpoint + "/restore", headers, payload: { version: 4, restoreVersion: 3 } });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().version, 5); assert.equal(restored.json().state, "draft"); assert.deepEqual(restored.json().content, content);
  assert.equal((await app.inject({ url: endpoint + "/versions/3", headers })).json().source, "final");
});

test("网页采纳方向进入独立编辑，三稿分别自动保存、定稿和冲突保留，桌面窄屏可操作且刷新不调用模型", async t => {
  const { chromium, expect } = await import("@playwright/test");
  const { createServer, request: forwardRequest } = await import("node:http");
  const { mkdir } = await import("node:fs/promises");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { listenHttpForFetch } = await import("../../../tests/http-listener.ts");
  const batch = await reviewedBatch(t); config.siteUrl = "http://127.0.0.1";
  const apiOrigin = await listenHttpForFetch(app.server); let unavailable = false;
  const api = createServer((request, response) => {
    if (unavailable && request.url?.startsWith("/api/admin/studio/drafts")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{}'); return; }
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); await mkdir(".impeccable/review", { recursive: true });
  const capture = async (name: string) => { assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false); await page.screenshot({ path: `.impeccable/review/writing-${name}.png`, fullPage: true }); };
  try {
    await page.goto(web.origin + `/admin/studio/topics/batches/${batch.batchId}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "历史批次", exact: true })).toBeVisible();
    await page.getByLabel("栏目选题", { exact: true }).getByRole("button").filter({ hasText: "角色参考怎么用" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "采纳并写稿", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "采纳选题，建立独立稿件" }); await expect(dialog).toBeVisible();
    await dialog.getByLabel("稿件标题", { exact: true }).fill("我的角色参考教程");
    await dialog.getByRole("textbox", { name: "自定义要求", exact: true }).fill("面向新手，不写成亲测");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture("adopt-mobile");
    await dialog.getByRole("button", { name: "建立稿件并进入写稿台" }).click();
    await expect(page.getByRole("heading", { name: "编辑稿件", exact: true })).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    const create = async (title: string) => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["lighting"], title } })).json().id;
    const secondId = await create("第二篇镜头教程"), thirdId = await create("第三篇独立观察");
    const second = await context.newPage(), third = await context.newPage(), stale = await context.newPage();
    await second.goto(web.origin + `/admin/studio/writing/${secondId}`); await third.goto(web.origin + `/admin/studio/writing/${thirdId}`); await stale.goto(page.url());
    await expect(stale.getByRole("textbox", { name: "纯口播正文", exact: true })).toBeVisible();
    const firstText = "先固定角色参考图，再逐镜检查光线。效果还未亲测，不能保证消除所有漂移。";
    await page.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await page.getByRole("textbox", { name: "纯口播正文", exact: true }).fill(firstText);
    await second.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await second.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("第二篇只讲光线检查。");
    await third.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await third.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("第三篇是完全独立的观察。");
    const read = async (selected: string) => (await app.inject({ url: `/api/admin/studio/drafts/${selected}`, headers })).json();
    await expect.poll(async () => (await read(id)).content.spoken).toBe(firstText);
    await expect.poll(async () => (await read(secondId)).content.spoken).toBe("第二篇只讲光线检查。");
    await expect.poll(async () => (await read(thirdId)).content.spoken).toBe("第三篇是完全独立的观察。");
    await stale.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await stale.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("旧窗口的修改，不允许覆盖新版本。");
    await expect(stale.getByRole("heading", { name: "本地内容已保留", exact: true })).toBeVisible(); assert.equal((await read(id)).content.spoken, firstText);
    await page.getByRole("button", { name: "确认定稿", exact: true }).click(); await expect.poll(async () => (await read(id)).state).toBe("final");
    await page.getByRole("tab", { name: "制作方案", exact: true }).click();
    await page.getByRole("textbox", { name: "制作方案正文", exact: true }).click(); await page.getByRole("textbox", { name: "制作方案正文", exact: true }).fill("录屏展示参考图与两镜头对照。");
    await expect.poll(async () => (await read(id)).content.production).toBe("录屏展示参考图与两镜头对照。");
    await page.getByRole("tab", { name: "纯口播", exact: true }).click(); await expect(page.getByRole("textbox", { name: "纯口播正文", exact: true })).toContainText(firstText);
    await page.setViewportSize({ width: 1440, height: 1100 }); await capture("editor-desktop");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture("editor-mobile");
    await third.getByRole("button", { name: "生成口播稿", exact: true }).click();
    await third.getByRole("button", { name: "生成口播与方案", exact: true }).click();
    const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
    const boss = await getBoss();
    await expect.poll(async () => (await app.inject({ url: `/api/admin/studio/drafts/${thirdId}/generation`, headers })).json().state).toBe("queued");
    const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job); await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
    await third.getByRole("button", { name: "刷新进度", exact: true }).click(); await third.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click(); await expect(third.getByRole("textbox", { name: "纯口播正文", exact: true })).toContainText(spoken);
    assert.equal((await read(id)).content.spoken, firstText); assert.equal((await read(secondId)).content.spoken, "第二篇只讲光线检查。");
    const calls = writingRequests.length; await page.reload(); await expect(page.getByRole("textbox", { name: "纯口播正文", exact: true })).toContainText(firstText); assert.equal(writingRequests.length, calls);
    unavailable = true; await page.reload(); await expect(page.getByRole("heading", { name: "稿件未能加载", exact: true })).toBeVisible(); await capture("error-mobile");
    unavailable = false; await page.getByRole("button", { name: "重新加载", exact: true }).click(); await expect(page.getByRole("heading", { name: "编辑稿件", exact: true })).toBeVisible();
    assert.equal(writingRequests.length, calls);
    const offline = await context.newPage(); await offline.goto(web.origin + `/admin/studio/writing/${secondId}`);
    await expect(offline.getByRole("textbox", { name: "纯口播正文", exact: true })).toBeVisible();
    await offline.route(`**/api/admin/studio/drafts/${secondId}`, async route => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
    await second.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await second.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("这个窗口已成功同步的内容。");
    await offline.getByRole("textbox", { name: "纯口播正文", exact: true }).click(); await offline.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("离线窗口的独立恢复内容，不能被另一个窗口清掉。");
    await expect.poll(async () => (await read(secondId)).content.spoken).toBe("这个窗口已成功同步的内容。");
    await expect(offline.getByRole("heading", { name: "本地内容已保留", exact: true })).toBeVisible();
    offline.on("dialog", dialog => dialog.accept()); await offline.reload();
    await expect(offline.getByRole("heading", { name: "发现本机未同步稿件", exact: true })).toBeVisible();
    await offline.setViewportSize({ width: 390, height: 1100 }); await offline.getByRole("heading", { name: "发现本机未同步稿件", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await offline.evaluate("document.documentElement.scrollWidth > innerWidth"), false); await offline.screenshot({ path: ".impeccable/review/writing-recovery-mobile.png" });
    await offline.getByRole("button", { name: "恢复本机内容", exact: true }).click();
    await expect(offline.getByRole("textbox", { name: "纯口播正文", exact: true })).toContainText("离线窗口的独立恢复内容，不能被另一个窗口清掉。");
    assert.equal((await read(secondId)).content.spoken, "这个窗口已成功同步的内容。"); await offline.close();
    let history = await read(id);
    for (let index = 0; index < 31; index++) history = (await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${id}`, headers,
      payload: { version: history.version, content: { ...history.content, notes: `第 ${index + 1} 次后续修订，不改旧定稿` } } })).json();
    await page.reload();
    if (await page.getByRole("heading", { name: "发现本机未同步稿件", exact: true }).count()) await page.getByRole("button", { name: "本次使用服务器版本", exact: true }).click();
    await expect(page.getByRole("button", { name: "版本 3 · 已确认定稿", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "修改历史", exact: true }).click();
    await page.getByRole("link", { name: "更早版本", exact: true }).click();
    await page.getByRole("heading", { name: "修改历史", exact: true }).scrollIntoViewIfNeeded(); assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/writing-history-mobile.png" });
    await page.getByRole("button", { name: "版本 3 · 已确认定稿", exact: true }).click();
    await expect(page.getByRole("region", { name: "历史版本对比", exact: true })).toContainText(firstText);
    if (await page.getByRole("dialog").count()) await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("link", { name: "写作规则", exact: true }).click();
    await page.getByRole("button", { name: "添加写作 Skill", exact: true }).click();
    const skillSection = page.getByRole("region", { name: "写作 Skill", exact: true }), form = skillSection.locator(":scope > form");
    await form.getByLabel("规则名称", { exact: true }).fill("写作测试短句规范");
    await form.getByLabel("写作规则", { exact: true }).fill("一句话讲一个操作，保留来源中的限制条件，不编造亲测经历。");
    await form.getByRole("button", { name: "添加写作规则", exact: true }).click();
    const rule = skillSection.locator(".studio-skill-list > details").filter({ has: page.locator("summary > strong", { hasText: "写作测试短句规范" }) });
    await expect(rule).toContainText("版本 1 · 已启用 · 全局"); await rule.locator(":scope > summary").click();
    await rule.getByLabel("启用此规则", { exact: true }).uncheck(); await rule.getByRole("button", { name: "保存为新版本", exact: true }).click();
    await expect(skillSection).toContainText("版本 2 · 已停用 · 全局");
    assert.equal((await app.inject({ url: "/api/admin/studio/writing-skills", headers })).json().rows.find((row: { name: string }) => row.name === "写作测试短句规范").enabled, false);
    await page.getByRole("heading", { name: "写作 Skill", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/writing-settings-mobile.png" });
    await page.goto(web.origin + `/admin/studio/writing/${id}`);
    await expect(page.getByRole("textbox", { name: "纯口播正文", exact: true })).toBeVisible();
    if (await page.getByRole("button", { name: "本次使用服务器版本", exact: true }).count()) await page.getByRole("button", { name: "本次使用服务器版本", exact: true }).click();
    const sharp = (await import("sharp")).default;
    const picture = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#e6f1f0" } }).png().toBuffer();
    await page.getByLabel("上传支撑图片", { exact: true }).setInputFiles({ name: "上传的参考图.png", mimeType: "image/png", buffer: picture });
    await expect(page.getByRole("tab", { name: "素材与备注", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".studio-rich-editor img")).toHaveCount(1);
    await expect(page.locator(".studio-rich-editor img")).toHaveAttribute("src", /^\/api\/admin\/studio\/image-assets\/[a-f0-9]{64}$/);
    await expect.poll(async () => (await read(id)).content.notes.includes("/api/admin/studio/image-assets/")).toBe(true);
    await page.getByRole("tab", { name: "纯口播", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "纯口播正文", exact: true })).toContainText(firstText);
    const pasted = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#eee9db" } }).png().toBuffer();
    await page.getByRole("textbox", { name: "纯口播正文", exact: true }).click();
    await page.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pasted.toString("base64"))}), letter => letter.charCodeAt(0)), clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "粘贴的镜头图.png", { type: "image/png" }));
      document.querySelector('[role="textbox"][aria-label="纯口播正文"]').dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    })()`);
    await expect(page.getByRole("tab", { name: "素材与备注", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".studio-rich-editor img")).toHaveCount(2);
    await expect.poll(async () => (await read(id)).content.notes.match(/\/api\/admin\/studio\/image-assets\//g)?.length).toBe(2);
    assert.equal((await read(id)).content.spoken, firstText); assert.equal((await read(secondId)).content.notes, "");
    let remoteImages = 0;
    await page.route("**/images-writing.external.invalid/**", route => { remoteImages++; return route.abort(); });
    const notes = (await read(id)).content.notes;
    await page.getByRole("checkbox", { name: "Markdown", exact: true }).check();
    await page.getByRole("textbox", { name: "素材与备注 Markdown", exact: true }).fill(notes + "\n\n![外部未导入图片](https://images-writing.external.invalid/tracker.png)");
    await page.getByRole("checkbox", { name: "Markdown", exact: true }).uncheck();
    await expect(page.getByText("外链图片尚未导入，请先上传到本稿素材。", { exact: true })).toBeVisible(); assert.equal(remoteImages, 0);
    await expect(page.locator(".studio-rich-editor img")).toHaveCount(2);
    await expect.poll(async () => (await read(id)).content.notes.includes("https://images-writing.external.invalid/tracker.png")).toBe(true);
    await page.getByRole("button", { name: "复制与导出", exact: true }).click();
    await page.getByRole("button", { name: "下载 ZIP 草稿", exact: true }).click(); await expect(page.getByText("存在尚未导入的图片，请先上传到本稿素材再导出完整离线包", { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("checkbox", { name: "Markdown", exact: true }).check(); await page.getByRole("textbox", { name: "素材与备注 Markdown", exact: true }).fill(notes);
    await page.getByRole("checkbox", { name: "Markdown", exact: true }).uncheck(); await expect.poll(async () => (await read(id)).content.notes).toBe(notes);
    await page.getByRole("button", { name: "复制与导出", exact: true }).click();
    const draftDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 ZIP 草稿", exact: true }).click(); const draftZip = await draftDownload;
    const zipPath = await draftZip.path(); assert.ok(zipPath); const { unzipSync, strFromU8 } = await import("fflate"), archive = unzipSync(await fs.readFile(zipPath));
    assert.equal(Object.keys(archive).filter(name => /\/images\/[a-f0-9]+\.png$/.test(name)).length, 2);
    const fullPath = Object.keys(archive).find(name => name.endsWith("/完整制作稿.md")); assert.ok(fullPath); assert.ok(strFromU8(archive[fullPath]!).includes(firstText)); assert.ok(!strFromU8(archive[fullPath]!).includes("/api/admin/"));
    assert.equal((await read(id)).state, "draft");
    const finalDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "定稿并下载 ZIP", exact: true }).click(); const finalZip = await finalDownload;
    assert.ok(finalZip.suggestedFilename().endsWith("-final.zip")); assert.equal((await read(id)).state, "final");
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]); await page.getByRole("tab", { name: "纯口播", exact: true }).click(); await page.getByRole("button", { name: "复制与导出", exact: true }).click(); await page.getByRole("button", { name: "复制富文本", exact: true }).click();
    await expect.poll(async () => page.evaluate("navigator.clipboard.readText().then(text => text.trim())")).toBe(firstText);
    const types = await page.evaluate("navigator.clipboard.read().then(items => items[0].types)"); assert.ok(Array.isArray(types)); assert.ok(types.includes("text/html")); assert.ok(types.includes("text/plain"));
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("tab", { name: "素材与备注", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1100 }); await capture("images-desktop");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture("images-mobile");
    assert.equal(writingRequests.length, calls);
    await Promise.all([second, third, stale].map(tab => tab.close()));
    await page.goto(web.origin + "/admin/studio/writing?view=history&state=all");
    await expect(page.locator(`#draft-batch-${batch.batchId}`)).toBeVisible();
    await page.locator(`section[aria-labelledby="draft-batch-${batch.batchId}"]`).getByRole("link", { name: "只看这一批", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`batchId=${batch.batchId}`));
    await expect(page.getByText(/正在查看单个选题批次/)).toBeVisible();
    await expect(page.getByRole("link", { name: "查看全部批次", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1100 }); await capture("batches-desktop");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture("batches-mobile");
    await page.goto(`${web.origin}/admin/studio/writing?batchId=${batch.batchId}&page=9999`);
    await expect(page.getByText("这一页没有稿件", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回第一页", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`batchId=${batch.batchId}`));
    await expect(page.locator(`#draft-batch-${batch.batchId}`)).toBeVisible();
    assert.equal(writingRequests.length, calls);
    await page.goto(web.origin + `/admin/studio/writing/${id}`);
    await expect(page.getByRole("heading", { name: "发现本机未同步稿件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "复制为新稿", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "本次使用服务器版本", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制为新稿", exact: true })).toBeEnabled();
    await page.getByLabel("稿件标题", { exact: true }).fill("复制前未保存的标题");
    await page.getByRole("button", { name: "复制为新稿", exact: true }).click();
    const openCopy = page.getByRole("link", { name: "打开副本", exact: true }); await expect(openCopy).toBeVisible();
    const copyHref = await openCopy.getAttribute("href"); assert.ok(copyHref);
    const copyId = copyHref.split("/").at(-1)!;
    const originalAfterCopy = await read(id), copied = await read(copyId);
    assert.equal(originalAfterCopy.title, "复制前未保存的标题"); assert.equal(copied.title, "复制前未保存的标题 · 副本");
    assert.deepEqual(copied.content, originalAfterCopy.content); assert.equal(copied.state, "draft");
    assert.equal(copied.snapshot.copiedFrom.version, originalAfterCopy.version);
    const [copiedPage] = await Promise.all([context.waitForEvent("page"), openCopy.click()]);
    await expect(copiedPage.getByRole("heading", { name: "编辑稿件", exact: true })).toBeVisible();
    await expect(copiedPage.getByText(/材料和规则沿用该版本的快照/)).toBeVisible();
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await copiedPage.setViewportSize({ width, height: 1100 });
      assert.equal(await copiedPage.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await copiedPage.screenshot({ path: `.impeccable/review/writing-copy-${suffix}.png` });
    }
    await copiedPage.getByRole("checkbox", { name: "Markdown", exact: true }).check();
    await copiedPage.getByRole("textbox", { name: "纯口播 Markdown", exact: true }).fill("副本窗口的独立口播。");
    await copiedPage.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await read(copyId)).content.spoken).toBe("副本窗口的独立口播。");
    assert.deepEqual(await read(id), originalAfterCopy); await copiedPage.close();
    assert.equal(writingRequests.length, calls);
  } finally { await browser.close(); await web.stop(); }
});

test("栏目学习只用五份不同确认稿，冻结训练和保留样本及规则，重复提交不再排队", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/columns/practice/learning";
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  assert.equal((await app.inject({ url: endpoint, headers })).json().run, null);
  const sourceIds: string[] = [];
  for (let index = 0; index < 5; index++) {
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: `学习用确认稿${index + 1}` } });
    assert.equal(created.statusCode, 200); const id = created.json().id; sourceIds.push(id);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${id}`, headers,
      payload: { version: 1, content: { spoken: `第${index + 1}篇自己的声音：先明确镜头制作问题，再演示步骤。未亲测，不承诺所有镜头有效。`, production: "录屏演示", notes: "" } } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${id}/finalize`, headers, payload: { version: 2 } })).statusCode, 200);
  }
  const insufficient = await app.inject({ method: "POST", url: "/api/admin/studio/columns/models/learning", headers, payload: {} });
  assert.equal(insufficient.statusCode, 200); assert.equal(insufficient.json().reason, "insufficient_samples");
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true); assert.ok(submitted.json().runId);
  const response = await app.inject({ url: endpoint, headers }); assert.equal(response.headers["cache-control"], "no-store");
  const run = response.json().run;
  assert.equal(run.state, "queued"); assert.equal(run.input.training.length, 3); assert.equal(run.input.heldOut.length, 2);
  const selected = [...run.input.training, ...run.input.heldOut.map((item: { sample: { projectId: string } }) => item.sample)];
  assert.equal(new Set(selected.map((sample: { projectId: string }) => sample.projectId)).size, 5);
  assert.ok(selected.every((sample: { projectId: string; version: number }) => sourceIds.includes(sample.projectId) && sample.version === 3));
  assert.ok(run.input.skills.some((skill: { id: string }) => skill.id === "humanizer-zh"));
  assert.ok(run.input.heldOut.every((item: { prompt: object }) => !JSON.stringify(item.prompt).includes("自己的声音")), "保留定稿不进入试写提示，包括嵌套的历史样本");
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: {} })).json().queued, false);
  const id = sourceIds[0]!;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${id}`, headers,
    payload: { version: 3, content: { spoken: "后来更正的正文", production: "录屏", notes: "" } } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().run.input, run.input);
  const { styleLearningQueue } = await import("../backend/style-learning.ts"), boss = await getBoss(), [job] = await boss.fetch(styleLearningQueue.name);
  assert.ok(job); await styleLearningQueue.run([job.data] as never[]); await boss.complete(styleLearningQueue.name, job.id);
  const candidate = (await app.inject({ url: endpoint, headers })).json().run;
  assert.equal(candidate.state, "activated"); assert.equal(candidate.result.candidate.rules[0].key, "opening");
  assert.equal(candidate.result.evaluations.length, 2); assert.ok(candidate.result.activatedSkill.id);
  const learnedId = candidate.result.activatedSkill.id, learned = (await app.inject({ url: "/api/admin/studio/writing-skills", headers })).json().rows.find((skill: { id: string }) => skill.id === learnedId);
  assert.ok(learned.body.includes("先用具体制作问题开头")); assert.deepEqual(learned.columnIds, ["practice"]);
  const next = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "采用学习规则的新稿" } });
  assert.ok((await app.inject({ url: `/api/admin/studio/drafts/${next.json().id}`, headers })).json().snapshot.skills.some((skill: { id: string }) => skill.id === learnedId));
  assert.ok(!(await app.inject({ url: `/api/admin/studio/drafts/${sourceIds[1]}`, headers })).json().snapshot.skills.some((skill: { id: string }) => skill.id === learnedId));
  assert.equal(styleRequests.filter(call => call.task.startsWith("style_compare_")).length, 2);
  assert.ok(styleRequests.filter(call => /style_(trial|baseline)_/.test(call.task)).every(call => !JSON.stringify(call).includes("自己的声音")));
});

test("栏目试写有事实问题时保留旧规则，学习期间用户手改规则也不能被自动结果覆盖", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/columns/practice/learning";
  const learnedId = (await app.inject({ url: endpoint, headers })).json().run.result.activatedSkill.id;
  const before = (await app.inject({ url: `/api/admin/studio/writing-skills/${learnedId}/versions/1`, headers })).json();
  await confirmStyleSamples(batch.batchId, "不通过的对照稿"); styleCheckFails = true;
  const rejected = await runStyleLearning(); styleCheckFails = false;
  assert.equal(rejected.state, "retained"); assert.equal(rejected.result.activatedSkill, null);
  assert.ok(rejected.result.reason.includes("未全部通过"));
  assert.equal((await app.inject({ url: `/api/admin/studio/writing-skills/${learnedId}/versions`, headers })).json().currentVersion, 1);
  await confirmStyleSamples(batch.batchId, "用户修改保护");
  styleDuringTrial = async () => { assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/writing-skills/${learnedId}`, headers,
    payload: { version: 1, body: "用户在其他窗口写的规则，必须保留。" } })).statusCode, 200); };
  const stale = await runStyleLearning();
  assert.equal(stale.state, "retained"); assert.ok(stale.result.reason.includes("不覆盖用户新状态"));
  const latest = (await app.inject({ url: `/api/admin/studio/writing-skills/${learnedId}/versions/2`, headers })).json();
  assert.equal(latest.body, "用户在其他窗口写的规则，必须保留。");
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/writing-skills/${learnedId}/versions/1`, headers })).json(), before);
});

test("用户可锁定栏目规则，下一次学习保留锁定文字且过期窗口不能改锁定项", async t => {
  const batch = await reviewedBatch(t), configUrl = "/api/admin/studio/columns/practice/learning/config";
  assert.equal((await app.inject({ url: configUrl })).statusCode, 401);
  await confirmStyleSamples(batch.batchId, "锁定前确认稿"); const initial = await runStyleLearning();
  assert.equal(initial.state, "activated");
  const before = (await app.inject({ url: configUrl, headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: configUrl, headers, payload: { version: before.config.version,
    skillVersion: initial.result.activatedSkill.version, lockedKeys: ["opening"] } })).statusCode, 200);
  await confirmStyleSamples(batch.batchId, "锁定后确认稿"); styleRuleBody = "换成新的开头表达，不应替换用户锁定的文字。";
  const next = await runStyleLearning(); styleRuleBody = "先用具体制作问题开头，演示后说明适用条件。";
  assert.equal(next.state, "activated"); assert.equal(next.result.candidate.rules[0].body, "先用具体制作问题开头，演示后说明适用条件。");
  const current = (await app.inject({ url: configUrl, headers })).json();
  assert.equal(current.config.lockedRules[0].key, "opening");
  assert.equal((await app.inject({ method: "PUT", url: configUrl, headers, payload: { version: before.config.version,
    skillVersion: next.result.activatedSkill.version, lockedKeys: [] } })).statusCode, 409);
});

test("学习步骤失败后可显式重试同一输入，复用已保存候选和试写而不重复付费", async t => {
  const batch = await reviewedBatch(t); await confirmStyleSamples(batch.batchId, "恢复验证稿");
  const endpoint = "/api/admin/studio/columns/practice/learning", firstCall = styleRequests.length;
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} }); assert.equal(submitted.statusCode, 200);
  const { styleLearningQueue } = await import("../backend/style-learning.ts"), boss = await getBoss(), [job] = await boss.fetch(styleLearningQueue.name); assert.ok(job);
  styleProviderFails = true; await assert.rejects(styleLearningQueue.run([job.data] as never[])); styleProviderFails = false;
  await boss.cancel(styleLearningQueue.name, job.id);
  const failed = (await app.inject({ url: endpoint, headers })).json().run;
  assert.equal(failed.state, "failed"); assert.equal(failed.completedSteps, 2);
  const retried = await app.inject({ method: "POST", url: endpoint, headers, payload: { retryFailed: true } });
  assert.equal(retried.statusCode, 200); assert.equal(retried.json().queued, true); assert.equal(retried.json().runId, failed.id);
  const [retry] = await boss.fetch(styleLearningQueue.name); assert.ok(retry);
  await styleLearningQueue.run([retry.data] as never[]); await boss.complete(styleLearningQueue.name, retry.id);
  const completed = (await app.inject({ url: endpoint, headers })).json().run;
  assert.equal(completed.state, "activated"); assert.deepEqual(completed.input, failed.input);
  const calls = styleRequests.slice(firstCall);
  assert.equal(calls.filter(call => call.task === "style_candidate").length, 1);
  assert.equal(calls.filter(call => call.task === "style_baseline_0").length, 1);
  assert.equal(calls.filter(call => call.task === "style_trial_0").length, 2);
});

test("每周自动学习复用持久任务，低磁盘及优先写稿时等待，暂停恢复不消耗重试或重复成功步骤", { timeout: 30000 }, async t => {
  const batch = await reviewedBatch(t), { studio } = await import("../server.ts");
  const schedule = studio.schedules?.find(item => item.name === "studio.style.learn.schedule");
  assert.ok(schedule, "栏目学习需要实际后台周期入口"); assert.equal(schedule.cron, "0 4 * * 0"); assert.equal(schedule.missed, "once");
  await confirmStyleSamples(batch.batchId, "周期验证稿");
  config.modelCallsEnabled = false; assert.deepEqual(await schedule.run(), { queued: 0 }); config.modelCallsEnabled = true;
  const results = await Promise.all([schedule.run(), schedule.run()]);
  assert.equal(results.reduce<number>((sum, item) => sum + (item as { queued: number }).queued, 0), 1);
  const { createStyleLearningQueue } = await import("../backend/style-learning.ts");
  const queue = createStyleLearningQueue(resources.host, resources.disk, resources.database), boss = await getBoss();
  const pending = (await boss.findJobs(queue.name, { queued: true }))[0]!; assert.ok(pending.id);
  const urgentDraft = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "优先生成的真实稿件" } })).json();
  const urgent = (await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${urgentDraft.id}/generation`, headers, payload: { version: 1 } })).json();
  assert.ok(urgent.jobId); const firstCall = styleRequests.length, previousModules = serverModules();
  installModules(previousModules.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  resources.capacity.diskBytes = 5_000_000_000; const stop = await workModuleQueues(boss);
  try {
    await resources.warm(); await delay(2200);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "created");
    resources.capacity.diskBytes = 6_000_000_000; await resources.warm(); await delay(2200);
    assert.equal((await boss.findJobs(queue.name, { id: pending.id }))[0]!.state, "created"); assert.equal(styleRequests.length, firstCall);
    stylePauseAfterTask = "style_candidate"; await boss.cancel("studio.writing.generate", urgent.jobId);
    const operationsUrl = "/api/admin/studio/model-operations", deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (!(await app.inject({ url: operationsUrl, headers })).json().enabled && (await boss.findJobs(queue.name, { id: pending.id }))[0]!.state === "created") break;
      await delay(30);
    }
    const waiting = (await boss.findJobs(queue.name, { id: pending.id }))[0]!;
    assert.equal(waiting.state, "created"); assert.equal(waiting.retryCount, 0); assert.equal(styleRequests.length - firstCall, 1, JSON.stringify(waiting.output));
    stylePauseAfterTask = undefined;
    const state = (await app.inject({ url: operationsUrl, headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: operationsUrl, headers, payload: { version: state.version, enabled: true } })).statusCode, 200);
    const finishDeadline = performance.now() + 8000;
    while (performance.now() < finishDeadline && (await boss.findJobs(queue.name, { id: pending.id }))[0]!.state !== "completed") await delay(30);
    const completed = (await boss.findJobs(queue.name, { id: pending.id }))[0]!;
    assert.equal(completed.state, "completed", JSON.stringify(completed.output)); assert.equal(completed.retryCount, 0);
    assert.equal(styleRequests.slice(firstCall).filter(call => call.task === "style_candidate").length, 1);
    assert.equal((await app.inject({ url: "/api/admin/studio/columns/practice/learning", headers })).json().run.state, "activated");
  } finally { stylePauseAfterTask = undefined; await stop(); installModules(previousModules); resources.capacity.diskBytes = 20 * 1024 ** 3; }
});

test("保留试写缺少事实材料时不启动付费学习，也不以空材料检查冒充通过", async t => {
  const batch = await reviewedBatch(t), endpoint = "/api/admin/studio/columns/practice/learning";
  const previous = (await app.inject({ url: endpoint, headers })).json().run.id;
  await confirmStyleSamples(batch.batchId, "只有正文没有事实引用", true);
  const before = styleRequests.length;
  const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, false);
  assert.equal(submitted.json().reason, "insufficient_evaluation_materials");
  assert.equal(styleRequests.length, before);
  assert.equal((await app.inject({ url: endpoint, headers })).json().run.id, previous);
});

test("学习等待全局模型空位时出现磁盘压力，释放空位也不发请求，恢复后沿用原任务", async t => {
  const batch = await reviewedBatch(t); await confirmStyleSamples(batch.batchId, "等待期间压力稿");
  const { withModelRequest } = await import("@aihot/backend/providers/model-requests");
  const { createStyleLearningQueue } = await import("../backend/style-learning.ts");
  const queue = createStyleLearningQueue(resources.host, resources.disk, resources.database), admission = queue.admission!();
  const started = [gate<void>(), gate<void>()], release = gate<void>();
  const holders = started.map(ready => withModelRequest(20000, undefined, async () => { ready.open(); await release.promise; }));
  let running: Promise<unknown> | undefined, jobId: string | undefined;
  const boss = await getBoss(), endpoint = "/api/admin/studio/columns/practice/learning";
  try {
    await Promise.all(started.map(ready => ready.promise)); await resources.warm();
    assert.equal(await admission.canStart(), true);
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
    assert.equal(submitted.statusCode, 200); const [job] = await boss.fetch(queue.name); assert.ok(job); jobId = job.id;
    const before = styleRequests.length;
    running = queue.run([job.data] as never[]).then(() => null, error => error);
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline && (await app.inject({ url: endpoint, headers })).json().run.state !== "running") await delay(20);
    await delay(300); assert.equal(styleRequests.length, before);
    resources.capacity.diskBytes = 5_000_000_000; await resources.warm();
    release.open(); await Promise.all(holders);
    const result = await running;
    assert.equal(styleRequests.length, before); assert.ok(result instanceof QueueDeferred);
    assert.equal((await app.inject({ url: endpoint, headers })).json().run.state, "queued");
    resources.capacity.diskBytes = 20 * 1024 ** 3; await resources.warm();
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    assert.equal((await app.inject({ url: endpoint, headers })).json().run.state, "activated");
  } finally {
    release.open(); await Promise.allSettled(holders); await running;
    if (jobId) await boss.cancel(queue.name, jobId);
    await admission.stop(); resources.capacity.diskBytes = 20 * 1024 ** 3;
  }
});

test("公众号采集和正文提取同样优先于栏目学习，待办完成后才能开始学习请求", async t => {
  const batch = await reviewedBatch(t); await confirmStyleSamples(batch.batchId, "采集优先验证稿");
  const { createStyleLearningQueue } = await import("../backend/style-learning.ts");
  const queue = createStyleLearningQueue(resources.host, resources.disk, resources.database), admission = queue.admission!();
  const boss = await getBoss(), before = styleRequests.length;
  try {
    await resources.warm(); assert.equal(await admission.canStart(), true);
    const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/columns/practice/learning", headers, payload: {} });
    assert.equal(submitted.statusCode, 200); const [job] = await boss.fetch(queue.name); assert.ok(job);
    for (const name of ["sources.mp", "content.extract-body"]) {
      await ensureQueue(name); const urgentId = await boss.send(name, { sourceId: batch.sourceId, articleId: batch.materialId.slice(5) }); assert.ok(urgentId);
      try {
        assert.equal(await admission.canStart(), false, `${name}未完成时不得领取学习`);
        await assert.rejects(queue.run([job.data] as never[]), QueueDeferred);
        assert.equal(styleRequests.length, before);
      } finally { await boss.cancel(name, urgentId); }
    }
    assert.equal(await admission.canStart(), true);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  } finally { await admission.stop(); }
});

test("网页按需读取栏目学习证据、保存规则锁定并恢复失败任务，错误和旧窗口不丢其他设置", async t => {
  const { chromium, expect } = await import("@playwright/test"), { createServer, request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const batch = await reviewedBatch(t); await confirmStyleSamples(batch.batchId, "网页规则学习样本"); await runStyleLearning();
  const address = app.server.address() as import("node:net").AddressInfo, apiOrigin = `http://127.0.0.1:${address.port}`;
  const api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(), panel = page.getByRole("region", { name: "栏目规则学习", exact: true });
  const endpoint = "/api/admin/studio/columns/practice/learning", configUrl = endpoint + "/config";
  const before = styleRequests.length; let reads = 0;
  page.on("request", request => { if (request.method() === "GET" && request.url().includes("/api/admin/studio/columns/") && request.url().includes("/learning")) reads++; });
  try {
    await fs.mkdir(".impeccable/review", { recursive: true });
    await page.goto(web.origin + "/admin/studio/settings/learning"); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
    await expect(panel.getByText("已启用新规则", { exact: true })).toBeVisible(); assert.ok(reads >= 2, "直接展示时按栏目读取状态与配置，不等待展开");
    const key = page.getByLabel("API Key", { exact: true }), cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true });
    await inSettingsSection(page, "models", () => key.fill("unsaved-learning-key")); await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-learning-cookie"));
    await expect(panel.getByText("已启用新规则", { exact: true })).toBeVisible();
    const locks = panel.getByRole("group", { name: "保留的表达规则", exact: true }), checkbox = locks.getByRole("checkbox");
    await expect(checkbox).toBeVisible(); const wasLocked = await checkbox.isChecked();
    await checkbox.setChecked(!wasLocked);
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("link", { name: "模型与费用", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("link", { name: "语言库与学习", exact: true }).click();
    await page.waitForTimeout(150);
    await expect(checkbox).toBeChecked({ checked: !wasLocked });
    await checkbox.setChecked(wasLocked);
    await panel.getByText("候选规则与样本依据", { exact: true }).click();
    await panel.getByText("先用具体制作问题开头，演示后说明适用条件。", { exact: true }).first().click();
    await panel.getByText("本次样本与冻结规则", { exact: true }).click();
    await expect(panel.getByText("网页规则学习样本5", { exact: true })).toBeVisible();
    await panel.getByText("查看试写与逐项对照", { exact: true }).click();
    await panel.getByText("保留稿 1 · 确认版本 3", { exact: true }).click();
    const firstEvaluation = panel.getByRole("group", { name: "保留稿 1 · 确认版本 3", exact: true });
    await firstEvaluation.getByText("事实 · 候选满足检查", { exact: true }).click();
    await expect(firstEvaluation.locator("details[open]").getByText("事实材料依据：" + body, { exact: true })).toBeVisible();
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/style-learning-${suffix}.png`, fullPage: true });
      await page.evaluate('document.querySelector(\'[aria-label="栏目规则学习"]\').scrollIntoView({ block: "start" })');
      await page.screenshot({ path: `.impeccable/review/style-learning-section-${suffix}.png` });
    }
    const oldPage = await context.newPage(); await oldPage.goto(web.origin + "/admin/studio/settings/learning");
    const old = oldPage.getByRole("region", { name: "栏目规则学习", exact: true });
    await expect(old.getByRole("checkbox")).toBeVisible();
    await checkbox.setChecked(!wasLocked); await panel.getByRole("button", { name: "保存锁定规则", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("锁定已保存");
    assert.equal((await app.inject({ url: configUrl, headers })).json().config.lockedRules.length, wasLocked ? 0 : 1);
    await expect(key).toHaveValue("unsaved-learning-key"); await expect(cookie).toHaveValue("SUB=unsaved-learning-cookie");
    await old.getByRole("checkbox").setChecked(!wasLocked); await old.getByRole("button", { name: "保存锁定规则", exact: true }).click();
    await expect(old.getByRole("status")).toContainText("锁定未保存"); await expect(old.getByRole("button", { name: "保存锁定规则", exact: true })).toBeDisabled(); await oldPage.close();
    await panel.getByLabel("学习栏目", { exact: true }).selectOption("models"); await expect(panel).toContainText("尚无学习记录");
    await panel.screenshot({ path: ".impeccable/review/style-learning-empty-mobile.png" });
    await page.route("**/columns/*/learning{,/config}", route => route.fulfill({ status: 503, body: "unavailable" }));
    await panel.getByRole("button", { name: "刷新学习记录", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("学习记录暂时无法读取");
    await expect(key).toHaveValue("unsaved-learning-key"); await expect(cookie).toHaveValue("SUB=unsaved-learning-cookie");
    await panel.screenshot({ path: ".impeccable/review/style-learning-error-mobile.png" });
    await page.unroute("**/columns/*/learning{,/config}"); await panel.getByRole("button", { name: "重试读取学习", exact: true }).click(); await expect(panel.getByRole("alert")).toHaveCount(0);
    assert.equal(styleRequests.length, before, "只读、锁定、切换及失败恢复均不调用模型");
    await confirmStyleSamples(batch.batchId, "网页失败重试样本");
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: {} }); assert.equal(submitted.statusCode, 200);
    const { styleLearningQueue } = await import("../backend/style-learning.ts"), boss = await getBoss(), [failed] = await boss.fetch(styleLearningQueue.name); assert.ok(failed);
    styleProviderFails = true;
    try { await assert.rejects(styleLearningQueue.run([failed.data] as never[])); } finally { styleProviderFails = false; }
    await boss.cancel(styleLearningQueue.name, failed.id);
    await panel.getByLabel("学习栏目", { exact: true }).selectOption("practice"); await expect(panel.getByText("学习未完成", { exact: true })).toBeVisible();
    const retryLock = panel.getByRole("checkbox"), originalLock = await retryLock.isChecked();
    await retryLock.setChecked(!originalLock);
    const confirmation = page.waitForEvent("dialog"), retryClick = panel.getByRole("button", { name: "重试本次学习", exact: true }).click();
    const discard = await confirmation, confirmationText = discard.message(); await discard.dismiss(); await retryClick;
    assert.match(confirmationText, /丢弃.*尚未保存.*锁定/);
    await expect(retryLock).toBeChecked({ checked: !originalLock });
    assert.equal((await app.inject({ url: endpoint, headers })).json().run.state, "failed");
    page.once("dialog", dialog => dialog.accept()); await panel.getByRole("button", { name: "重试本次学习", exact: true }).click();
    await expect(panel.getByText("等待执行", { exact: true })).toBeVisible();
    const [retry] = await boss.fetch(styleLearningQueue.name); assert.ok(retry); await styleLearningQueue.run([retry.data] as never[]); await boss.complete(styleLearningQueue.name, retry.id);
    await panel.getByRole("button", { name: "刷新学习记录", exact: true }).click(); await expect(panel.getByText("已启用新规则", { exact: true })).toBeVisible();
    await expect(key).toHaveValue("unsaved-learning-key"); await expect(cookie).toHaveValue("SUB=unsaved-learning-cookie");
  } finally { styleProviderFails = false; await context.close(); await browser.close(); await web.stop(); }
});

test("上传支撑图片只归属指定稿件，实际解码为本地私有素材、同内容去重，其他稿件不会自动拥有图片", async t => {
  const batch = await reviewedBatch(t), create = async () => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const id = await create(), otherId = await create(), endpoint = `/api/admin/studio/drafts/${id}/images`;
  const sharp = (await import("sharp")).default, body = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#e6f1f0" } }).png().toBuffer();
  const input = { name: "角色参考图.png", contentType: "image/png", bodyBase64: body.toString("base64") };
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload: input })).statusCode, 401);
  const uploaded = await app.inject({ method: "POST", url: endpoint, headers, payload: input });
  assert.equal(uploaded.statusCode, 200); const image = uploaded.json(); assert.match(image.assetId, /^[a-f0-9]{64}$/);
  assert.equal(image.name, "角色参考图.png"); assert.equal(image.source.kind, "upload"); assert.ok(image.url.startsWith("/api/admin/studio/image-assets/"));
  const stored = await app.inject({ url: image.url, headers }); assert.equal(stored.statusCode, 200); assert.equal(stored.headers["cache-control"], "no-store");
  const decoded = await sharp(stored.rawPayload).metadata(); assert.equal(decoded.width, 8); assert.equal(decoded.height, 8);
  assert.equal((await app.inject({ url: image.url })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: input })).json().assetId, image.assetId);
  assert.equal((await app.inject({ url: endpoint, headers })).json().rows.length, 1);
  assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${otherId}/images`, headers })).json().rows.length, 0);
});

test("稿件不能保存未关联的图片引用，避免跨稿件串图或把不存在的素材写入历史", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, content = { spoken: "逐镜检查角色。", production: "", notes: `![不存在的图片](/api/admin/studio/image-assets/${"a".repeat(64)})` };
  const saved = await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } });
  assert.equal(saved.statusCode, 409);
  const original = (await app.inject({ url: endpoint, headers })).json(); assert.equal(original.version, 1); assert.equal(original.content.notes, "");
  assert.equal((await app.inject({ url: endpoint + "/versions", headers })).json().total, 1);
  const otherId = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["lighting"] } })).json().id;
  const sharp = (await import("sharp")).default, bytes = await sharp({ create: { width: 19, height: 11, channels: 3, background: "#7273dd" } }).png().toBuffer();
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "仅属于本稿的参考图.png", contentType: "image/png", bodyBase64: bytes.toString("base64") } })).json();
  const linked = { ...content, notes: `![本稿参考图](${image.url})` };
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${otherId}`, headers, payload: { version: 1, content: linked } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: linked } })).statusCode, 200);
  const invalid = await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "伪装图片.png", contentType: "image/png", bodyBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64") } });
  assert.equal(invalid.statusCode, 400);
  assert.equal((await app.inject({ url: endpoint + "/images", headers })).json().rows.length, 1);
});

test("从两篇稿件素材列表移除图片后，已保存定稿仍保护原图，旧窗口移除不能覆盖新版本", async t => {
  const batch = await reviewedBatch(t), create = async () => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const id = await create(), otherId = await create(), endpoint = `/api/admin/studio/drafts/${id}`;
  const sharp = (await import("sharp")).default, body = await sharp({ create: { width: 16, height: 8, channels: 3, background: "#ff2211" } }).png().toBuffer();
  const input = { name: "定稿图片.png", contentType: "image/png", bodyBase64: body.toString("base64") };
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers, payload: input })).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${otherId}/images`, headers, payload: input })).json().assetId, image.assetId);
  const content = { spoken: "参考这张图片逐镜检查。", production: "", notes: `![参考图](${image.url})` };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 2 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, content: { ...content, notes: "" } } })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.assetId}`, headers, payload: { version: 3 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.assetId}`, headers, payload: { version: 4 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/studio/drafts/${otherId}/images/${image.assetId}`, headers, payload: { version: 1 } })).statusCode, 200);
  assert.equal((await app.inject({ url: endpoint + "/images", headers })).json().rows.length, 0);
  assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${otherId}/images`, headers })).json().rows.length, 0);
  const { createImageAssets } = await import("../backend/image-assets.ts"); await createImageAssets().prune(new Date(Date.now() + 60_000));
  assert.equal((await app.inject({ url: image.url, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: endpoint + "/versions/3", headers })).json().content.notes, content.notes);
  assert.equal((await app.inject({ url: endpoint, headers })).json().content.notes, "");
});

test("从未被保存稿件引用的上传图片移除后可以实际回收，不因附件元数据无限占盘", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, sharp = (await import("sharp")).default;
  const body = await sharp({ create: { width: 17, height: 9, channels: 3, background: "#2277ff" } }).png().toBuffer();
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "未采用的图片.png", contentType: "image/png", bodyBase64: body.toString("base64") } })).json();
  assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.assetId}`, headers, payload: { version: 1 } })).statusCode, 200);
  const { createImageAssets } = await import("../backend/image-assets.ts");
  await assert.doesNotReject(() => createImageAssets().prune(new Date(Date.now() + 60_000)));
  assert.equal((await app.inject({ url: image.url, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: endpoint + "/images", headers })).json().rows.length, 0);
});

test("稿件按明确保存版本导出可离线读图的ZIP，包含分开的口播方案来源与完整稿，不串入其他稿或调用模型", async t => {
  const batch = await reviewedBatch(t), create = async (title: string) => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title } })).json().id;
  const id = await create("角色参考的条件与操作"), otherId = await create("另一篇独立私稿"), endpoint = `/api/admin/studio/drafts/${id}`;
  const sharp = (await import("sharp")).default, bytes = await sharp({ create: { width: 23, height: 13, channels: 3, background: "#cdeaef" } }).png().toBuffer();
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "支持素材.png", contentType: "image/png", bodyBase64: bytes.toString("base64") } })).json();
  const content = { spoken: "先固定参考图，再逐镜检查。效果未亲测，不保证消除所有漂移。", production: "录屏展示两个镜头的角色与光线对照。", notes: `![角色参考图](${image.url})` };
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } });
  await app.inject({ method: "PATCH", url: `/api/admin/studio/drafts/${otherId}`, headers, payload: { version: 1, content: { spoken: "他稿内容不能串进这个导出包", production: "", notes: "" } } });
  const input = { version: 2, mode: "draft" }, calls = writingRequests.length;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", payload: input })).statusCode, 401);
  const download = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: input });
  assert.equal(download.statusCode, 200); assert.equal(download.headers["content-type"], "application/zip"); assert.equal(download.headers["cache-control"], "no-store");
  assert.equal(download.headers["x-studio-writing-version"], "2"); assert.ok(String(download.headers["content-disposition"]).startsWith("attachment;"));
  const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(download.rawPayload), names = Object.keys(files);
  const read = (suffix: string) => { const path = names.find(name => name.endsWith("/" + suffix)); assert.ok(path); return strFromU8(files[path]!); };
  assert.ok(read("口播稿.md").includes(content.spoken)); assert.ok(!read("口播稿.md").includes(content.production));
  assert.ok(read("制作方案.md").includes(content.production)); assert.ok(read("来源清单.md").includes(batch.url));
  const full = read("完整制作稿.md"); assert.ok(full.includes(content.spoken)); assert.match(full, /!\[角色参考图\]\(images\/[a-f0-9]+\.png\)/);
  assert.ok(!full.includes("/api/admin/")); assert.ok(!names.some(name => name.includes("..")));
  const picture = names.find(name => /\/images\/[a-f0-9]+\.png$/.test(name)); assert.ok(picture); const decoded = await sharp(files[picture]).metadata(); assert.equal(decoded.width, 23);
  assert.ok(!names.filter(name => name.endsWith(".md")).some(name => strFromU8(files[name]!).includes("他稿内容不能串进这个导出包")));
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "draft"); assert.equal(writingRequests.length, calls);
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 2, content: { ...content, spoken: "新版本还需要继续改" } } });
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: input })).statusCode, 409);
});

test("未导入的外链图片不能伪装成完整离线包，Markdown代码示例中的图片语法仍原样保留", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, external = "https://missing-image.example/unfetched.png";
  let version = 1;
  for (const notes of [`![尚未导入](${external})`, `<img src="${external}" alt="未导入图片">`]) {
    await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version, content: { spoken: "先核对材料再制作。", production: "", notes } } }); version++;
    assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version, mode: "draft" } })).statusCode, 409);
  }
  const notes = "这是语法示例，不是支撑图片：\n\n```markdown\n![示例](" + external + ")\n```";
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version, content: { spoken: "核对示例中的步骤。", production: "", notes } } }); version++;
  const download = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version, mode: "draft" } }); assert.equal(download.statusCode, 200);
  const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(download.rawPayload), name = Object.keys(files).find(name => name.endsWith("/素材与备注.md")); assert.ok(name);
  assert.ok(strFromU8(files[name]!).includes(notes));
});

test("定稿导出先确认同一版本且重复导出不堆积版本，后续改稿不改既有定稿或归档内容，模型关闭也能导出", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "我确认采用的制作建议" } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, content = { spoken: "先确认适用条件，再决定是否用于更多分镜。", production: "录屏演示两镜头对比。", notes: "没有亲测，不保证结果。" };
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } });
  const calls = writingRequests.length; config.modelCallsEnabled = false;
  const exported = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "final" } });
  assert.equal(exported.statusCode, 200); assert.equal(exported.headers["x-studio-writing-version"], "3");
  const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(exported.rawPayload), name = Object.keys(files).find(name => name.endsWith("/manifest.json")); assert.ok(name);
  const manifest = JSON.parse(strFromU8(files[name]!)); assert.equal(manifest.state, "final"); assert.equal(manifest.version, 3);
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "final");
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 3, mode: "final" } })).headers["x-studio-writing-version"], "3");
  assert.equal((await app.inject({ url: endpoint + "/versions", headers })).json().total, 3);
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, content: { ...content, spoken: "后续未确认的新改动" } } });
  assert.equal((await app.inject({ url: endpoint + "/versions/3", headers })).json().content.spoken, content.spoken);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 3, mode: "final" } })).statusCode, 409);
  assert.equal(writingRequests.length, calls);
});

test("操作系统拒读图片时定稿导出明确报告素材问题，不发送残缺ZIP或提前确认定稿，恢复后原版本可重试", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, sharp = (await import("sharp")).default;
  const body = await sharp({ create: { width: 29, height: 17, channels: 3, background: "#f2cfc0" } }).png().toBuffer();
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "要随稿导出的图片.png", contentType: "image/png", bodyBase64: body.toString("base64") } })).json();
  await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: { spoken: "检查镜头衔接的条件。", production: "", notes: `![说明图](${image.url})` } } });
  const fault = mock.method(fs, "readFile", async () => { throw Object.assign(new Error("controlled image-read fault"), { code: "EACCES" }); }); syncBuiltinESMExports();
  try {
    const failed = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "final" } });
    assert.equal(failed.statusCode, 409); assert.ok(failed.json().detail.includes("图片")); assert.ok(!failed.json().detail.includes("controlled image-read fault"));
    const current = (await app.inject({ url: endpoint, headers })).json(); assert.equal(current.version, 2); assert.equal(current.state, "draft");
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "final" } })).statusCode, 200);
});

test("HTML实体编码的图片也必须归属本稿，无法离线重写时明确拒绝导出而不交付缺图包", async t => {
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, content = { spoken: "核对参考图再制作。", production: "", notes: `<img src="/api/admin/studio/image&#45;assets/${"a".repeat(64)}" alt="编码图片">` };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 409);
  const sharp = (await import("sharp")).default, bytes = await sharp({ create: { width: 31, height: 19, channels: 3, background: "#eec1d9" } }).png().toBuffer();
  const image = (await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "编码地址参考.png", contentType: "image/png", bodyBase64: bytes.toString("base64") } })).json();
  content.notes = `<img src="${image.url.replace("image-assets", "image&#45;assets")}" alt="编码图片">`;
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  const failed = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "final" } });
  assert.equal(failed.statusCode, 409); assert.match(failed.json().detail, /图片/);
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "draft");
  content.notes = `![编码图片](${image.url})`;
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 2, content } })).statusCode, 200);
  const download = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 3, mode: "draft" } });
  assert.equal(download.statusCode, 200);
  const { unzipSync } = await import("fflate"); assert.ok(Object.keys(unzipSync(download.rawPayload)).some(name => name.endsWith(`/images/${image.assetId}.png`)));
});

test("栏目语言库只纳入明确确认的定稿，同稿重复确认去重，普通保存不替换样本，再次定稿保留旧历史", async t => {
  const library = "/api/admin/studio/language-samples?columnId=practice&limit=100";
  assert.equal((await app.inject({ url: library })).statusCode, 401);
  const batch = await reviewedBatch(t), id = (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const endpoint = `/api/admin/studio/drafts/${id}`, calls = writingRequests.length;
  const read = async () => {
    const response = await app.inject({ url: library, headers }); assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store"); return response.json().rows.filter((row: { projectId: string }) => row.projectId === id);
  };
  assert.deepEqual(await read(), []);
  const content = { spoken: "镜头里的角色一换景就变脸，先检查参考图有没有固定。", production: "演示录屏", notes: "这不是事实知识库" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, mode: "auto", content } })).statusCode, 200);
  assert.deepEqual(await read(), [], "自动保存不是认可");
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "draft" } })).statusCode, 200);
  assert.deepEqual(await read(), [], "草稿导出不是定稿样本");
  const final = await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 2 } }); assert.equal(final.statusCode, 200);
  const rows = await read(); assert.equal(rows.length, 1); assert.equal(rows[0].version, 3); assert.equal(rows[0].spoken, content.spoken);
  assert.deepEqual(rows[0].columnIds, ["practice"]); assert.equal(rows[0].source, "confirmed_final");
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 3 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 3, mode: "final" } })).statusCode, 200);
  assert.deepEqual(await read(), rows, "重复确认或定稿导出不新增样本/改变确认时间");
  const changed = { ...content, spoken: "先锁住参考图，再用两个连续镜头做对照。" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, mode: "manual", content: changed } })).statusCode, 200);
  assert.deepEqual(await read(), rows, "普通修改不撤回先前明确确认的样本");
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 4 } })).statusCode, 200);
  const latest = await read(); assert.equal(latest.length, 1); assert.equal(latest[0].version, 5); assert.equal(latest[0].spoken, changed.spoken);
  assert.equal((await app.inject({ url: endpoint + "/versions/3", headers })).json().content.spoken, content.spoken);
  assert.equal(writingRequests.length, calls, "读取与登记不调用模型");
});

test("新稿只冻结本栏目少量确认样本，样本后来更正不改旧稿，初稿与Humanizer润色实际读取冻结样本", async t => {
  const batch = await reviewedBatch(t), create = async (title: string) => {
    const result = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title } });
    assert.equal(result.statusCode, 200); return result.json().id as string;
  };
  const sourceId = await create("自用角色教程样本"), sourceUrl = `/api/admin/studio/drafts/${sourceId}`;
  const content = { spoken: "角色一换镜头就变脸？先别急着换模型。把参考图固定，再看两个镜头的差别。", production: "", notes: "" };
  assert.equal((await app.inject({ method: "PATCH", url: sourceUrl, headers, payload: { version: 1, content } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: sourceUrl + "/finalize", headers, payload: { version: 2 } })).statusCode, 200);
  const targetId = await create("参考图检查的另一期口播"), targetUrl = `/api/admin/studio/drafts/${targetId}`;
  const target = (await app.inject({ url: targetUrl, headers })).json();
  assert.ok(target.snapshot.languageSamples, "新稿须冻结实际选用的栏目确认样本");
  const samples = target.snapshot.languageSamples;
  assert.ok(samples.length > 0 && samples.length <= 3);
  const own = samples.find((sample: { projectId: string }) => sample.projectId === sourceId);
  assert.ok(own); assert.equal(own.version, 3); assert.equal(own.spoken, content.spoken);
  assert.ok(samples.every((sample: { columnIds: string[] }) => sample.columnIds.includes("practice")));
  const updated = { ...content, spoken: "先锁住参考图。然后只改变镜头角度，看角色有没有漂移。" };
  assert.equal((await app.inject({ method: "PATCH", url: sourceUrl, headers, payload: { version: 3, content: updated } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: sourceUrl + "/finalize", headers, payload: { version: 4 } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: targetUrl, headers })).json().snapshot.languageSamples, samples);
  const initialCalls = writingRequests.length;
  assert.equal((await app.inject({ method: "POST", url: targetUrl + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  const calls = writingRequests.slice(initialCalls);
  assert.deepEqual((calls.find(call => call.task === "writing_draft")!.snapshot as { languageSamples: unknown }).languageSamples, samples);
  assert.deepEqual(calls.find(call => call.task === "writing_polish")!.languageSamples, samples);
  assert.equal((await app.inject({ url: targetUrl + "/generation", headers })).json().state, "completed");
  const { chromium, expect } = await import("@playwright/test"), { createServer, request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { listenHttpForFetch } = await import("../../../tests/http-listener.ts");
  // Ten newer confirmations force the original source onto page two of the real index.
  for (let index = 0; index < 10; index++) {
    const id = await create(`栏目样本 ${index + 1}`), url = `/api/admin/studio/drafts/${id}`;
    assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: 1, content: { ...content, spoken: `第${index + 1}份：先给出具体制作问题，再演示操作，最后说明限制。` } } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: url + "/finalize", headers, payload: { version: 2 } })).statusCode, 200);
  }
  const address = app.server.address();
  const apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const writingCalls = writingRequests.length;
  try {
    let reads = 0;
    page.on("request", request => { if (request.url().includes("/api/admin/studio/language-samples?")) reads++; });
    await page.goto(web.origin + "/admin/studio/settings/learning"); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const library = page.getByRole("region", { name: "栏目确认样本", exact: true });
    await expect(library.getByRole("button", { name: "下一页样本", exact: true })).toBeEnabled(); assert.ok(reads >= 1, "直接展示时读取有界分页，不读取整库");
    const key = page.getByLabel("API Key", { exact: true }); await inSettingsSection(page, "models", () => key.fill("unsaved-language-key"));
    const cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true }); await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-language-cookie"));
    await expect(library.getByLabel("样本栏目", { exact: true })).toBeVisible();
    await expect(library.getByRole("button", { name: "下一页样本", exact: true })).toBeVisible();
    await library.getByLabel("样本栏目", { exact: true }).selectOption("practice");
    await library.getByRole("button", { name: "下一页样本", exact: true }).click();
    const source = library.locator(".studio-language-samples > details").filter({ has: page.getByText("自用角色教程样本", { exact: true }) });
    await source.locator("summary").click(); await expect(source).toContainText("确认版本 5"); await expect(source).toContainText(updated.spoken);
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/language-library-${suffix}.png`, fullPage: true });
      await page.locator('[aria-labelledby="language-samples-title"]').screenshot({ path: `.impeccable/review/language-library-section-${suffix}.png` });
    }
    await library.getByLabel("样本栏目", { exact: true }).selectOption("models");
    await expect(library).toContainText("当前栏目还没有确认样本");
    await page.locator('[aria-labelledby="language-samples-title"]').screenshot({ path: ".impeccable/review/language-library-empty-mobile.png" });
    await page.route("**/api/admin/studio/language-samples?*", route => route.fulfill({ status: 503, body: "unavailable" }));
    await library.getByRole("button", { name: "刷新样本", exact: true }).click(); await expect(library.getByRole("alert")).toContainText("样本暂时无法读取");
    await expect(key).toHaveValue("unsaved-language-key"); await expect(cookie).toHaveValue("SUB=unsaved-language-cookie");
    await page.locator('[aria-labelledby="language-samples-title"]').screenshot({ path: ".impeccable/review/language-library-error-mobile.png" });
    await page.unroute("**/api/admin/studio/language-samples?*"); await library.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(library.getByRole("alert")).toHaveCount(0); await expect(library).toContainText("当前栏目还没有确认样本");
    await page.goto(web.origin + `/admin/studio/writing/${targetId}`);
    await page.getByRole("button", { name: "写作依据", exact: true }).click();
    const frozen = page.getByRole("group", { name: "本稿栏目定稿样本", exact: true });
    await expect(frozen).not.toHaveAttribute("open", ""); await frozen.locator(":scope > summary").click();
    const old = frozen.locator(".studio-language-samples > details").filter({ has: page.getByText("自用角色教程样本", { exact: true }) });
    await old.locator("summary").click(); await expect(old).toContainText("确认版本 3"); await expect(old).toContainText(content.spoken); await expect(old).not.toContainText(updated.spoken);
    await expect(old.getByRole("link", { name: "另页打开来源稿", exact: true })).toHaveAttribute("target", "_blank");
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/language-frozen-${suffix}.png`, fullPage: true });
    }
    assert.equal(writingRequests.length, writingCalls, "样本阅读/筛选/重试不调用模型");
  } finally { await browser.close(); await web.stop(); }
});

test("采纳只带入本批次冻结来源图，两篇稿件共享字节但各自移除且不因原文更正换图", async t => {
  const png = await sharp({ create: { width: 360, height: 240, channels: 3, background: "#234567" } }).png().toBuffer();
  let imageRequests = 0;
  const source = http.createServer((_req, res) => { imageRequests++; res.writeHead(200, { "content-type": "image/png" }); res.end(png); });
  const origin = await listenHttpForFetch(source), previous = config.allowPrivateNetworkFetch;
  t.after(async () => { config.allowPrivateNetworkFetch = previous; await new Promise<void>(resolve => source.close(() => resolve())); });
  config.allowPrivateNetworkFetch = true;
  const batch = await reviewedBatch(t, origin + "/old.png");
  config.allowPrivateNetworkFetch = previous;
  const frozen = (await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}/materials`, headers })).json().rows[0].sourceImages.images[0];
  await upsertMaterial({ sourceId: batch.sourceId, title: "来源新版本", url: batch.url, via: "import", bodyText: "新版原文，不应替换旧稿。", bodyStatus: "ok",
    media: [{ kind: "image", url: origin + "/new.png", alt: "新版图" }] });
  const ids: string[] = [];
  for (const direction of ["reference", "lighting"]) {
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: [direction] } });
    assert.equal(created.statusCode, 200); ids.push(created.json().id);
    const images = (await app.inject({ url: `/api/admin/studio/drafts/${created.json().id}/images`, headers })).json().rows;
    assert.equal(images.length, 1, "冻结来源图应直接出现在本稿素材列表");
    assert.equal(images[0].assetId, frozen.assetId); assert.equal(images[0].url, frozen.url); assert.equal(images[0].name, "隔离测试：角色参考图设置");
    assert.deepEqual(images[0].source, { kind: "news", materialId: batch.materialId, originalUrl: origin + "/old.png", articleUrl: batch.url, revision: 1, rights: "unknown" });
    assert.equal((await app.inject({ url: images[0].url, headers })).statusCode, 200);
  }
  assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/studio/drafts/${ids[0]}/images/${frozen.assetId}`, headers, payload: { version: 1 } })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${ids[0]}/images`, headers })).json().rows.length, 0);
  assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${ids[1]}/images`, headers })).json().rows.length, 1);
  const second = `/api/admin/studio/drafts/${ids[1]}`;
  assert.equal((await app.inject({ method: "PATCH", url: second, headers, payload: { version: 1,
    content: { spoken: "先固定参考图，再说明未亲测的限制。", production: "录屏展示设置。", notes: `![角色参考图设置](${frozen.url})` } } })).statusCode, 200);
  const download = await app.inject({ method: "POST", url: second + "/export", headers, payload: { version: 2, mode: "draft" } });
  assert.equal(download.statusCode, 200);
  const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(download.rawPayload), names = Object.keys(files);
  const picture = names.find(name => name.endsWith(`/images/${frozen.assetId}.png`)), manifest = names.find(name => name.endsWith("/manifest.json")), notes = names.find(name => name.endsWith("/素材与备注.md"));
  assert.ok(picture); assert.ok(manifest); assert.ok(notes);
  assert.equal((await sharp(files[picture]!).metadata()).width, 360);
  assert.ok(strFromU8(files[notes]!).includes(`images/${frozen.assetId}.png`));
  assert.ok(!strFromU8(files[notes]!).includes("/api/admin/"));
  assert.equal(JSON.parse(strFromU8(files[manifest]!)).images[0].source.originalUrl, origin + "/old.png");
  assert.equal(JSON.parse(strFromU8(files[manifest]!)).images[0].source.rights, "unknown");
  const available = (await app.inject({ url: second + "/images", headers })).json().rows;
  const beforeWriting = writingRequests.length;
  const submitted = await app.inject({ method: "POST", url: second + "/generation", headers, payload: { version: 2 } });
  assert.equal(submitted.statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: second + `/images/${frozen.assetId}`, headers, payload: { version: 2 } })).statusCode, 200);
  assert.equal((await app.inject({ url: second + "/images", headers })).json().rows.length, 0);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name);
  assert.ok(job); chooseAvailableImages = true;
  try { await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id); }
  finally { chooseAvailableImages = false; }
  const modelInput = writingRequests.slice(beforeWriting).find(request => request.task === "writing_draft")!;
  assert.deepEqual(modelInput.availableImages, available, "模型只能收到本稿提交时实际保存的图片清单");
  const generated = (await app.inject({ url: second + "/generation", headers })).json();
  assert.deepEqual(generated.result.shots[0].assetIds, [frozen.assetId]);
  const saved = (await app.inject({ url: second, headers })).json();
  assert.ok(saved.content.notes.includes(`](${frozen.url})`), "推荐图片应直接进入完整制作稿的素材备注");
  assert.ok(!saved.content.spoken.includes("/api/admin/"), "纯口播不混入图片或制作说明");
  const illustrated = await app.inject({ method: "POST", url: second + "/export", headers, payload: { version: saved.version, mode: "draft" } });
  assert.equal(illustrated.statusCode, 200);
  const illustratedFiles = unzipSync(illustrated.rawPayload), illustratedNotes = Object.keys(illustratedFiles).find(name => name.endsWith("/素材与备注.md"));
  assert.ok(illustratedNotes); assert.ok(strFromU8(illustratedFiles[illustratedNotes]!).includes(`images/${frozen.assetId}.png`));
  assert.equal(imageRequests, 1, "采纳和阅读只复用保存字节，不下载新图");
  newsImageBrowserCase = { batchId: batch.batchId, generatedId: ids[1]!, sourceUrl: origin + "/old.png", articleUrl: batch.url, assetId: frozen.assetId };
});

test("AI制作稿不能编造外链或使用他稿/已移出图片，含HTML与srcset的非法配图在润色前失败", async t => {
  const batch = await reviewedBatch(t);
  const donor = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#876543" } }).png().toBuffer();
  const upload = { name: "隔离测试：其他稿图片", contentType: "image/png", bodyBase64: png.toString("base64") };
  const image = await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${donor.json().id}/images`, headers, payload: upload });
  assert.equal(image.statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss();
  for (const [kind, markup] of [
    ["external", "![编造的截图](https://invented-image.example/fake.png)"],
    ["foreign", `![其他稿图片](${image.json().url})`],
    ["removed", `![已经移出图片](${image.json().url})`],
    ["html", `<img src="${image.json().url.replaceAll("/", "&#x2f;")}">`],
    ["srcset", '<picture><source srcset="https://invented-image.example/fake.png"><img src="https://invented-image.example/other.png"></picture>'],
  ]) {
    const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
      payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
    assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
    if (kind === "removed") {
      assert.equal((await app.inject({ method: "POST", url: endpoint + "/images", headers, payload: upload })).statusCode, 200);
      assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.json().assetId}`, headers, payload: { version: 1 } })).statusCode, 200);
    }
    const before = (await app.inject({ url: endpoint, headers })).json(), calls = writingRequests.length;
    assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
    const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job); generatedImageMarkup = "\n\n" + markup;
    try { await assert.rejects(writingGenerationQueue.run([job.data] as never[]), kind); }
    finally { generatedImageMarkup = ""; await boss.cancel(writingGenerationQueue.name, job.id); }
    assert.deepEqual((await app.inject({ url: endpoint, headers })).json().content, before.content);
    assert.equal((await app.inject({ url: endpoint + "/generation", headers })).json().state, "failed");
    const callsForCase = writingRequests.slice(calls);
    assert.deepEqual(callsForCase[0]!.availableImages, []);
    assert.equal(callsForCase.filter(request => request.task === "writing_polish").length, 0);
  }
});

test("旧格式写稿任务暂停后复用原步骤，恢复不增加图片字段或重付初稿调用", async t => {
  const batch = await reviewedBatch(t), operations = "/api/admin/studio/model-operations";
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name);
  assert.ok(job);
  // Upgrade fixture: the persisted input shape emitted before the image policy existed. Assertions stay at API/model seams.
  await sql`UPDATE studio_writing_generations SET input = input - 'imagePolicy' - 'availableImages' WHERE id = ${(job.data as { generationId: string }).generationId}`;
  const calls = writingRequests.length; pauseAfterTask = "writing_draft";
  try { await assert.rejects(writingGenerationQueue.run([job.data] as never[]), QueueDeferred); }
  finally { pauseAfterTask = undefined; }
  const stopped = (await app.inject({ url: operations, headers })).json();
  assert.equal((await app.inject({ method: "PUT", url: operations, headers, payload: { version: stopped.version, enabled: true } })).statusCode, 200);
  await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  const oldCalls = writingRequests.slice(calls), draftCalls = oldCalls.filter(request => request.task === "writing_draft");
  assert.equal(draftCalls.length, 1); assert.equal(Object.hasOwn(draftCalls[0]!, "availableImages"), false); assert.equal(Object.hasOwn(draftCalls[0]!, "imagePolicy"), false);
  assert.equal((await app.inject({ url: endpoint + "/generation", headers })).json().state, "completed");
  assert.ok((await app.inject({ url: endpoint, headers })).json().content.spoken.length > 0);
});

test("写稿页可查看冻结新闻图出处、插入保存和独立移除，自动配图及实际下载ZIP可用", async () => {
  const { chromium, expect } = await import("@playwright/test"), { request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const fixture = newsImageBrowserCase; assert.ok(fixture);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: fixture.batchId, directionIds: ["reference"], title: "隔离测试：新闻配图稿" } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = http.createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  let sourceRequests = 0; const calls = writingRequests.length;
  page.on("request", request => { if (request.url().startsWith(new URL(fixture.sourceUrl).origin + "/")) sourceRequests++; });
  const capture = async (name: string) => {
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: `.impeccable/review/writing-source-${name}.png`, fullPage: true });
  };
  try {
    await page.goto(web.origin + `/admin/studio/writing/${created.json().id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const gallery = page.locator(".studio-writing-images"), image = gallery.getByRole("img", { name: "隔离测试：角色参考图设置", exact: true });
    await expect(image).toBeVisible(); await expect(image).toHaveJSProperty("naturalWidth", 360);
    await expect(gallery).toContainText("文章版本 1 · 授权未知");
    await expect(gallery.getByRole("link", { name: "来源文章", exact: true })).toHaveAttribute("href", fixture.articleUrl);
    await expect(gallery.getByRole("link", { name: "图片原链接", exact: true })).toHaveAttribute("href", fixture.sourceUrl);
    await gallery.getByRole("button", { name: "插入素材备注", exact: true }).click();
    await expect.poll(async () => (await app.inject({ url: endpoint, headers })).json().content.notes).toContain(fixture.assetId);
    await expect(gallery.getByRole("button", { name: "移出素材列表", exact: true })).toBeEnabled();
    await capture("desktop"); await page.setViewportSize({ width: 390, height: 1100 }); await capture("mobile");
    await gallery.getByRole("button", { name: "移出素材列表", exact: true }).click();
    await expect(page.getByText("素材列表为空。", { exact: false })).toBeVisible(); await capture("empty-mobile");
    await page.getByRole("button", { name: "复制与导出", exact: true }).click();
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 ZIP 草稿", exact: true }).click();
    const file = await (await download).path(); assert.ok(file);
    const { unzipSync } = await import("fflate"), archive = unzipSync(await fs.readFile(file));
    assert.ok(Object.keys(archive).some(name => name.endsWith(`/images/${fixture.assetId}.png`)));
    await page.goto(web.origin + `/admin/studio/writing/${fixture.generatedId}`);
    await page.getByRole("tab", { name: "素材与备注", exact: true }).click();
    await expect(page.locator(".studio-rich-editor .tiptap img")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "推荐配图", exact: true })).toBeVisible();
    await capture("generated-mobile");
    assert.equal(sourceRequests, 0); assert.equal(writingRequests.length, calls);
  } finally { await browser.close(); await web.stop(); }
});

test("生成期间图片受任务保护，完成后未选中的已移出图片可回收，不永久占用小磁盘", async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  const png = await sharp({ create: { width: 73, height: 51, channels: 3, background: "#654321" } }).png().toBuffer();
  const uploaded = await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "隔离测试：未选中图", contentType: "image/png", bodyBase64: png.toString("base64") } });
  assert.equal(uploaded.statusCode, 200); const image = uploaded.json();
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.assetId}`, headers, payload: { version: 1 } })).statusCode, 200);
  const { createImageAssets } = await import("../backend/image-assets.ts"), assets = createImageAssets(), future = new Date(Date.now() + 31 * 86400_000);
  await assets.prune(future); assert.equal((await app.inject({ url: image.url, headers })).statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss(), [job] = await boss.fetch(writingGenerationQueue.name);
  assert.ok(job); await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  assert.equal((await app.inject({ url: endpoint + "/generation", headers })).json().state, "completed");
  await assets.prune(future); assert.equal((await app.inject({ url: image.url, headers })).statusCode, 404);
});

test("模型不能用清单内的实体HTML图片交付无法离线导出的成功稿，改用镜头ID重试后可导出", async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  const png = await sharp({ create: { width: 79, height: 53, channels: 3, background: "#345678" } }).png().toBuffer();
  const uploaded = await app.inject({ method: "POST", url: endpoint + "/images", headers,
    payload: { name: "隔离测试：可导出图", contentType: "image/png", bodyBase64: png.toString("base64") } });
  assert.equal(uploaded.statusCode, 200); const image = uploaded.json(), calls = writingRequests.length;
  const before = (await app.inject({ url: endpoint, headers })).json();
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss();
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
  const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  generatedImageMarkup = `\n\n<img src="${image.url.replaceAll("/", "&#x2f;")}">`;
  try { await assert.rejects(writingGenerationQueue.run([job.data] as never[])); }
  finally { generatedImageMarkup = ""; await boss.cancel(writingGenerationQueue.name, job.id); }
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().content, before.content);
  assert.equal((await app.inject({ url: endpoint + "/generation", headers })).json().state, "failed");
  assert.equal(writingRequests.slice(calls).filter(request => request.task === "writing_polish").length, 0);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1, retryFailed: true } })).statusCode, 200);
  const [retry] = await boss.fetch(writingGenerationQueue.name); assert.ok(retry); chooseAvailableImages = true;
  try { await writingGenerationQueue.run([retry.data] as never[]); await boss.complete(writingGenerationQueue.name, retry.id); }
  finally { chooseAvailableImages = false; }
  const saved = (await app.inject({ url: endpoint, headers })).json();
  assert.ok(saved.content.notes.includes(`](${image.url})`));
  const download = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: saved.version, mode: "draft" } });
  assert.equal(download.statusCode, 200);
  const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(download.rawPayload);
  const notes = Object.keys(files).find(name => name.endsWith("/素材与备注.md")); assert.ok(notes);
  assert.ok(strFromU8(files[notes]!).includes(`images/${image.assetId}.png`));
  assert.ok(!strFromU8(files[notes]!).includes("/api/admin/"));
  assert.ok(Object.keys(files).some(name => name.endsWith(`/images/${image.assetId}.png`)));
});
test("采纳时可增加本批之外已收录新闻和表达作品，补充只冻结到本稿且后续原文更改不回写", async t => {
  const batch = await reviewedBatch(t), extraBody = "先展示两个镜头的变化，再说参考图的设置顺序；只是结构样本，不证明本期效果。";
  const extra = await upsertMaterial({ sourceId: batch.sourceId, title: "补充的表达参考", url: batch.url + "/extra", via: "import",
    discoveredAt: new Date("2099-01-01T00:00:00Z"), publishedAt: new Date(), bodyText: extraBody, bodyStatus: "ok" });
  const id = "news:" + extra.articleId;
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: {
    requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], references: [
      { materialId: batch.materialId, role: "fact" }, { materialId: id, role: "expression" },
    ],
  } });
  assert.equal(created.statusCode, 200);
  const endpoint = "/api/admin/studio/drafts/" + created.json().id;
  const draft = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(draft.snapshot.materials.find((item: { id: string }) => item.id === id).body, extraBody);
  assert.deepEqual(draft.snapshot.supplementalMaterialIds, [id]);
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}/materials`, headers })).json().total, 1);
  await upsertMaterial({ sourceId: batch.sourceId, title: "已更新的表达参考", url: batch.url + "/extra", via: "import", bodyText: "来源修改后的内容", bodyStatus: "ok" });
  assert.equal((await app.inject({ url: endpoint, headers })).json().snapshot.materials.find((item: { id: string }) => item.id === id).body, extraBody);
});

test("用户主动局部或整稿改写先交付独立提案，来源与Skill冻结，明确采纳才保存且过期提案不能覆盖手改", async t => {
  assert.equal((await app.inject({ url: "/api/admin/studio/drafts/00000000-0000-4000-8000-000000000000/revisions" })).statusCode, 401);
  const batch = await reviewedBatch(t);
  const create = async () => (await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"] } })).json().id;
  const id = await create(), otherId = await create(), endpoint = "/api/admin/studio/drafts/" + id;
  const content = { spoken: "开场。这段需要改写。结尾保持。", production: "制作方案不改", notes: "备注不改" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  assert.equal((await app.inject({ url: endpoint + "/revisions" })).statusCode, 401);
  const requestId = randomUUID(), payload = { requestId, version: 2, field: "spoken", instruction: "改成自然的动作说明，保留来源限制", selection: { start: 3, end: 10, text: "这段需要改写。" } };
  const submitted = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload });
  assert.equal(submitted.statusCode, 200); const revisionId = submitted.json().id;
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload })).json().id, revisionId);
  const queue = serverModules().find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.writing.revise")!, boss = await getBoss();
  assert.ok(queue); const run = async () => { const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); };
  const before = writingRequests.length; await run();
  const rows = (await app.inject({ url: endpoint + "/revisions", headers })).json().rows;
  assert.equal(rows[0].id, revisionId); assert.equal(rows[0].state, "completed"); assert.equal(rows[0].applied, false);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().content, content);
  const calls = writingRequests.slice(before); assert.deepEqual(calls.map(call => call.task), ["writing_revision", "writing_revision_check"]);
  assert.ok((calls[0]!.project as WritingProject).snapshot.skills.some(skill => skill.id === "humanizer-zh"));
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/drafts/${otherId}/revisions/${revisionId}/apply`, headers, payload: { version: 1 } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${revisionId}/apply`, headers, payload: { version: 2 } })).statusCode, 200);
  const applied = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(applied.content.spoken, "开场。" + revisionText + "结尾保持。"); assert.equal(applied.version, 3);
  assert.equal(applied.content.production, content.production); assert.equal(applied.content.notes, content.notes);
  const whole = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload: { requestId: randomUUID(), version: 3, field: "spoken", instruction: "整稿再精炼一点" } });
  assert.equal(whole.statusCode, 200); await run();
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, content: { ...content, spoken: "这是后来手动确认的新内容。" } } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${whole.json().id}/apply`, headers, payload: { version: 4 } })).statusCode, 409);
  assert.equal((await app.inject({ url: endpoint, headers })).json().content.spoken, "这是后来手动确认的新内容。");
});

test("单文件HTML导出嵌入真实图片可离线查看，去掉脚本且定稿与导出版本一致", async t => {
  const batch = await reviewedBatch(t);
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers,
    payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"], title: "带图片的离线制作稿" } });
  const endpoint = "/api/admin/studio/drafts/" + created.json().id;
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#28635a" } }).png().toBuffer();
  const image = await app.inject({ method: "POST", url: endpoint + "/images", headers, payload: { name: "参考图.png", contentType: "image/png", bodyBase64: png.toString("base64") } });
  assert.equal(image.statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1,
    content: { spoken: "先检查两个镜头，保留来源条件。", production: "录屏展示参考图。", notes: `![实际参考图](${image.json().url})\n\n<script>window.bad=1</script>` } } })).statusCode, 200);
  const exported = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 2, mode: "final", format: "html" } });
  assert.equal(exported.statusCode, 200); assert.match(String(exported.headers["content-type"]), /^text\/html/);
  assert.match(String(exported.headers["content-disposition"]), /\.html/); assert.equal(exported.headers["x-studio-writing-version"], "3");
  const html = exported.body; assert.ok(html.includes("带图片的离线制作稿")); assert.ok(!html.includes("<script")); assert.ok(!html.includes("/api/admin/"));
  const imageData = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(html); assert.ok(imageData);
  const actual = await sharp(Buffer.from(imageData[1]!, "base64")).metadata(); assert.equal(actual.width, 64); assert.equal(actual.height, 64);
  assert.equal((await app.inject({ url: endpoint, headers })).json().state, "final");
});

test("本稿只冻结所选表达作者的已保存模式，移除关注不改旧稿，初稿和润色均使用原版本", async t => {
  const batch = await reviewedBatch(t), previous = getGlobalDispatcher(), transport = new MockAgent();
  transport.disableNetConnect(); transport.enableNetConnect(/^127\.0\.0\.1:\d+$/); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); });
  const creator = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://weibo.com/u/5756404150" } })).json().creator;
  const { creatorQueue } = await import("../backend/creator-collection.ts"), { creatorExpressionQueue } = await import("../backend/creator-expressions.ts");
  const boss = await getBoss();
  for (let index = 0; index < 2; index++) {
    weiboFixture(transport, { postId: "530000000000001" + index, text: body + `这是表达样本${index + 1}。`, complete: true });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(creatorQueue.name); assert.ok(job); await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  }
  const expressions = `/api/admin/studio/creators/${creator.id}/expressions`;
  assert.equal((await app.inject({ method: "POST", url: expressions, headers, payload: {} })).json().queued, true);
  const [learn] = await boss.fetch(creatorExpressionQueue.name); assert.ok(learn); await creatorExpressionQueue.run([learn.data] as never[]); await boss.complete(creatorExpressionQueue.name, learn.id);
  const library = (await app.inject({ url: expressions, headers })).json().library; assert.ok(library);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows[0];
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: batch.batchId, directionIds: ["reference"],
    references: [{ materialId: batch.materialId, role: "fact" }, { materialId: `creator:${post.id}`, role: "expression" }] } });
  assert.equal(created.statusCode, 200, created.body); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  const project = (await app.inject({ url: endpoint, headers })).json();
  assert.deepEqual(project.snapshot.expressionLibraries, [library]);
  const account = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}`, headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${creator.id}/archive`, headers, payload: { version: account.version, archived: true } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().snapshot.expressionLibraries, [library]);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 1 } })).statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job);
  await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
  assert.deepEqual((writingRequests.at(-3)!.snapshot as WritingProject["snapshot"]).expressionLibraries, [library]);
  assert.deepEqual(writingRequests.at(-2)!.expressionLibraries, [library]);
  transport.assertNoPendingInterceptors();
});

test("栏目学习冻结已确认稿相对AI原稿的实际修改，只用训练组，不把未确认自动保存当偏好", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({url: "/api/admin/studio/topic-batches?limit=1", headers})).json().rows[0];
  assert.equal(batch.recommendationState, "reviewed"); const boss = await getBoss();
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  const confirmed: string[] = [];
  for (let index = 0; index < 6; index++) {
    const created = await app.inject({method: "POST", url: "/api/admin/studio/drafts", headers, payload: {requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: `修改偏好样本${index}`} });
    assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `/api/admin/studio/drafts/${id}`;
    assert.equal((await app.inject({method: "POST", url: endpoint + "/generation", headers, payload: {version: 1} })).statusCode, 200);
    const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job); await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
    const generated = (await app.inject({url: endpoint, headers})).json(); assert.equal(generated.version, 2);
    assert.equal((await app.inject({method: "PATCH", url: endpoint, headers, payload: {version: 2, mode: index === 5 ? "auto" : "manual",
      content: {...generated.content, spoken: `先对照两个镜头检查角色与光线，这是第${index}份修改。保留参考图，效果仍需自己核实，不保证消除所有漂移。`} } })).statusCode, 200);
    if (index < 5) { assert.equal((await app.inject({method: "POST", url: endpoint + "/finalize", headers, payload: {version: 3} })).statusCode, 200); confirmed.push(id); }
  }
  const endpoint = "/api/admin/studio/columns/practice/learning", submission = await app.inject({method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(submission.statusCode, 200); assert.equal(submission.json().queued, true);
  const frozen = (await app.inject({url: endpoint, headers})).json().run.input;
  assert.equal(frozen.editExamples?.length, 3);
  assert.ok(frozen.editExamples.every((example: {projectId: string; finalVersion: number; baselineVersion: number; beforeSpoken: string}) => confirmed.includes(example.projectId)
    && example.finalVersion === 4 && example.baselineVersion === 2 && example.beforeSpoken === spoken
    && frozen.training.some((sample: {projectId: string}) => sample.projectId === example.projectId)
    && !frozen.heldOut.some((held: {sample: {projectId: string}}) => held.sample.projectId === example.projectId)));
  const selected = frozen.training[0];
  assert.equal((await app.inject({method: "PATCH", url: `/api/admin/studio/drafts/${selected.projectId}`, headers, payload: {version: 4, content: {spoken: "后来改动，不进入已提交学习。", production: "", notes: ""}}})).statusCode, 200);
  assert.deepEqual((await app.inject({url: endpoint, headers})).json().run.input, frozen);
  const { styleLearningQueue } = await import("../backend/style-learning.ts"), [job] = await boss.fetch(styleLearningQueue.name); assert.ok(job);
  await styleLearningQueue.run([job.data] as never[]); await boss.complete(styleLearningQueue.name, job.id);
  assert.deepEqual(styleRequests.filter(input => input.task === "style_candidate").at(-1)!.editExamples, frozen.editExamples);
  const {startWebServer} = await import("../../../apps/web/tests/web-server.ts"), {chromium, expect} = await import("@playwright/test");
  const {mkdir} = await import("node:fs/promises"), {request: forwardRequest} = await import("node:http");
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = http.createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), {method: request.method, headers: request.headers}, result => {response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);});
    upstream.on("error", () => {response.writeHead(502); response.end();}); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), calls = provider.hits();
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    await page.goto(web.origin + "/admin/studio/settings/learning"); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", {name: "栏目规则学习", exact: true})).toBeVisible(); await page.getByLabel("学习栏目", {exact: true}).selectOption("practice");
    await page.getByText("本次样本与冻结规则", {exact: true}).click(); await page.getByText("用户修改对照（3）", {exact: true}).click();
    const summary = page.getByText(`${selected.title} · AI 版本 2 → 确认版本 4`, {exact: true}); await summary.click(); const comparison = summary.locator("..");
    await expect(comparison.getByText(spoken, {exact: true})).toBeVisible(); await expect(comparison.getByText(selected.spoken, {exact: true})).toBeVisible();
    await expect(comparison).not.toContainText("后来改动，不进入已提交学习。");
    await mkdir(".impeccable/review", {recursive: true});
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({width, height: 1000}); await comparison.getByText("用户确认的口播", {exact: true}).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({path: `.impeccable/review/style-edit-examples-${suffix}.png`});
    }
    assert.equal(provider.hits(), calls);
  } finally {await browser.close(); await web.stop();}
});

test("修改对照的12000字符额度包含数组括号与逗号，超额整份跳过且不截断原稿", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({url: "/api/admin/studio/topic-batches?limit=1", headers})).json().rows[0];
  assert.equal(batch.recommendationState, "reviewed"); const boss = await getBoss();
  const {writingGenerationQueue} = await import("../backend/writing-generation.ts");
  // A UUID/version envelope is 107 characters; 3 complete 3892-character originals
  // serialize to 12001 characters once [] and the two commas are included.
  generatedSpokenOverride = "甲".repeat(3892);
  try {
    for (let index = 0; index < 5; index++) {
      const created = await app.inject({method: "POST", url: "/api/admin/studio/drafts", headers, payload: {requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: `完整对照额度${index}`} });
      assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
      assert.equal((await app.inject({method: "POST", url: endpoint + "/generation", headers, payload: {version: 1}})).statusCode, 200);
      const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job); await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
      assert.equal((await app.inject({method: "PATCH", url: endpoint, headers, payload: {version: 2, content: {spoken: `先固定参考图，再检查两个镜头；第${index}份确认修改。`, production: "", notes: ""}}})).statusCode, 200);
      assert.equal((await app.inject({method: "POST", url: endpoint + "/finalize", headers, payload: {version: 3}})).statusCode, 200);
    }
    const endpoint = "/api/admin/studio/columns/practice/learning";
    const submitted = await app.inject({method: "POST", url: endpoint, headers, payload: {}}); assert.equal(submitted.statusCode, 200); assert.equal(submitted.json().queued, true);
    const input = (await app.inject({url: endpoint, headers})).json().run.input;
    assert.equal(input.editExamples.length, 2);
    assert.ok(JSON.stringify(input.editExamples).length <= 12000);
    assert.ok(input.editExamples.every((example: {beforeSpoken: string}) => example.beforeSpoken === generatedSpokenOverride));
  } finally {generatedSpokenOverride = undefined;}
});

test("稿件按选题批次筛选后再统计分页，保留原批次快照与独立地址，读取不调用模型", async () => {
  const endpoint = "/api/admin/studio/drafts";
  const initialTotal = (await app.inject({ url: endpoint, headers })).json().total;
  const batches = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=2", headers })).json().rows;
  const first = { batchId: batches[0].id }, other = { batchId: batches[1].id };
  const initialBatchTotal = (await app.inject({ url: `${endpoint}?batchId=${first.batchId}`, headers })).json().total;
  const ids: string[] = [];
  for (const title of ["本批教程第一稿", "本批教程第二稿"]) {
    const created = await app.inject({ method: "POST", url: endpoint, headers, payload: {
      requestId: randomUUID(), batchId: first.batchId, directionIds: ["reference"], title,
    } });
    assert.equal(created.statusCode, 200); ids.push(created.json().id);
  }
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: {
    requestId: randomUUID(), batchId: other.batchId, directionIds: ["lighting"], title: "另一期的独立稿",
  } })).statusCode, 200);
  const hits = provider.hits();
  for (const page of [1, 2]) {
    const result = await app.inject({ url: `${endpoint}?batchId=${first.batchId}&limit=1&page=${page}`, headers });
    assert.equal(result.statusCode, 200); assert.equal(result.json().total, initialBatchTotal + 2);
    assert.equal(result.json().hasMore, page < initialBatchTotal + 2); assert.equal(result.json().rows.length, 1);
    const row = result.json().rows[0];
    assert.equal(row.batchId, first.batchId); assert.equal(row.snapshot.batch.id, first.batchId);
  }
  const allBatchRows = (await app.inject({ url: `${endpoint}?batchId=${first.batchId}&limit=100`, headers })).json().rows;
  assert.ok(ids.every(id => allBatchRows.some((row: WritingProject) => row.id === id)));
  const empty = await app.inject({ url: `${endpoint}?batchId=${randomUUID()}`, headers });
  assert.equal(empty.statusCode, 200); assert.equal(empty.json().total, 0); assert.deepEqual(empty.json().rows, []);
  assert.equal((await app.inject({ url: `${endpoint}?batchId=invalid`, headers })).statusCode, 400);
  assert.equal((await app.inject({ url: `${endpoint}?batchId=${first.batchId}` })).statusCode, 401);
  assert.equal((await app.inject({ url: endpoint, headers })).json().total, initialTotal + 3);
  assert.equal(provider.hits(), hits);
});

test("复制已保存定稿创建独立草稿并保留冻结证据，幂等重试不造多稿且过期版本不能复制", async () => {
  const drafts = "/api/admin/studio/drafts", batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const created = await app.inject({ method: "POST", url: drafts, headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: "可复制的手改稿", instructions: "保留限制" } });
  assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `${drafts}/${id}`;
  const content = { spoken: "先对比两个镜头，再检查参考图；效果尚未亲测。", production: "0–15秒展示问题，随后录屏。", notes: "保留本稿出处。" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/finalize", headers, payload: { version: 2 } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json(), before = (await app.inject({ url: drafts, headers })).json().total;
  const samplesUrl = "/api/admin/studio/language-samples?columnId=practice&limit=100";
  const samplesBefore = await app.inject({ url: samplesUrl, headers });
  assert.equal(samplesBefore.statusCode, 200);
  const hits = provider.hits(), payload = { requestId: randomUUID(), version: original.version };
  const copied = await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload });
  assert.equal(copied.statusCode, 200, copied.body); assert.notEqual(copied.json().id, id);
  const copyEndpoint = `${drafts}/${copied.json().id}`, copy = (await app.inject({ url: copyEndpoint, headers })).json();
  assert.equal(copy.version, 1); assert.equal(copy.state, "draft"); assert.equal(copy.title, "可复制的手改稿 · 副本");
  assert.equal(copy.instructions, "保留限制"); assert.deepEqual(copy.content, content);
  assert.deepEqual(copy.snapshot, { ...original.snapshot, copiedFrom: { projectId: id, version: original.version } });
  assert.equal((await app.inject({ url: copyEndpoint + "/versions", headers })).json().total, 1);
  assert.equal((await app.inject({ url: copyEndpoint + "/generation", headers })).json().state, "not_started");
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload })).json().id, copy.id);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { ...payload, version: 2 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { requestId: randomUUID(), version: 2 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/copy", payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: `${drafts}/${randomUUID()}/copy`, headers, payload: { requestId: randomUUID(), version: 1 } })).statusCode, 404);
  assert.equal((await app.inject({ url: drafts, headers })).json().total, before + 1);
  assert.equal((await app.inject({ method: "PATCH", url: copyEndpoint, headers, payload: { version: 1, content: { ...content, spoken: "这是副本的独立修改。" } } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), original);
  assert.equal((await app.inject({ url: samplesUrl, headers })).body, samplesBefore.body);
  assert.equal(provider.hits(), hits);
});

test("复制现稿保留当前素材及正文仍引用的移出图片，独立引用阻止误清理且副本可以离线导出", async () => {
  const drafts = "/api/admin/studio/drafts", batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const created = await app.inject({ method: "POST", url: drafts, headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const endpoint = `${drafts}/${created.json().id}`;
  const upload = async (name: string, background: string) => {
    const bytes = await sharp({ create: { width: 13, height: 7, channels: 3, background } }).png().toBuffer();
    const result = await app.inject({ method: "POST", url: endpoint + "/images", headers, payload: { name, contentType: "image/png", bodyBase64: bytes.toString("base64") } });
    assert.equal(result.statusCode, 200); return result.json();
  };
  const active = await upload("留在素材栏的图.png", "#aae17e"), referenced = await upload("正文引用但移出素材栏.png", "#ae179a"), unused = await upload("未采用的图.png", "#7238ed");
  const content = { spoken: "副本仍要能查看原图。", production: "镜头对照", notes: `![原图](${referenced.url})` };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  for (const image of [referenced, unused]) assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${image.assetId}`, headers, payload: { version: 2 } })).statusCode, 200);
  const payload = { requestId: randomUUID(), version: 2 };
  const [first, retry] = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: endpoint + "/copy", headers, payload })));
  assert.equal(first.statusCode, 200, first.body); assert.equal(retry.json().id, first.json().id);
  const copyEndpoint = `${drafts}/${first.json().id}`;
  const attachments = (await app.inject({ url: copyEndpoint + "/images", headers })).json().rows;
  assert.deepEqual(attachments.map((image: { assetId: string }) => image.assetId), [active.assetId]);
  assert.deepEqual(attachments[0].source, active.source); assert.equal(attachments[0].name, active.name);
  assert.equal((await app.inject({ method: "DELETE", url: endpoint + `/images/${active.assetId}`, headers, payload: { version: 2 } })).statusCode, 200);
  const { createImageAssets } = await import("../backend/image-assets.ts"); await createImageAssets().prune(new Date(Date.now() + 60_000));
  assert.equal((await app.inject({ url: active.url, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: referenced.url, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: unused.url, headers })).statusCode, 404);
  const download = await app.inject({ method: "POST", url: copyEndpoint + "/export", headers, payload: { version: 1, mode: "draft" } });
  assert.equal(download.statusCode, 200, download.body);
  const { unzipSync } = await import("fflate"); assert.ok(Object.keys(unzipSync(download.rawPayload)).some(name => name.endsWith(`/images/${referenced.assetId}.png`)));
  assert.equal((await app.inject({ method: "PATCH", url: copyEndpoint, headers, payload: { version: 1, content: { ...content, spoken: "副本可以另改。" } } })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().content, content);
});

test("复制达到标题长度上限的合法稿件时不能截断emoji码点或产生替换字符", async () => {
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const title = "甲".repeat(234) + "😀结尾四字";
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: {
    requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title,
  } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  const copied = await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { requestId: randomUUID(), version: 1 } });
  assert.equal(copied.statusCode, 200, copied.body);
  const copy = (await app.inject({ url: `/api/admin/studio/drafts/${copied.json().id}`, headers })).json();
  assert.equal(copy.title, "甲".repeat(234) + " · 副本");
  assert.equal((await app.inject({ url: endpoint, headers })).json().title, title);
});

test("旧稿显式选择最新写作规则才冻结当前Skill生成可比较修订，后续规则更新不改变本次输入或原稿", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: "应用新规则仍保留事实的旧稿" } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: { spoken: body, production: "原来的制作方案", notes: "原来的备注" } } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json();
  const ruleBody = "先指出镜头问题，再讲实际动作，结尾保留尚未验证的条件。";
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/writing-skills", headers, payload: { name: "显式采用最新规则", body: ruleBody, columnIds: ["practice"], enabled: true } });
  assert.equal(added.statusCode, 200); const skill = added.json();
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), original);
  const payload = { requestId: randomUUID(), version: 2, field: "spoken", instruction: "按当前启用的新规范修改，保留原事实和条件", useLatestSkills: true };
  const submitted = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/writing-skills/${skill.id}`, headers, payload: { version: 1, body: "后来的第二版规则，不应进入已提交改稿。" } })).statusCode, 200);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!, boss = await getBoss();
  const before = writingRequests.length, [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const calls = writingRequests.slice(before); assert.deepEqual(calls.map(call => call.task), ["writing_revision", "writing_revision_check"]);
  const input = calls[0]!.project as WritingProject;
  assert.ok(input.snapshot.skills.some(rule => rule.id === skill.id && rule.version === "1" && rule.body === ruleBody));
  assert.deepEqual(input.snapshot.materials.map(({ id, url, body }) => ({ id, url, body })),
    original.snapshot.materials.map(({ id, url, body }: { id: string; url: string; body: string }) => ({ id, url, body })));
  assert.deepEqual(input.snapshot.references, original.snapshot.references);
  const row = (await app.inject({ url: endpoint + "/revisions", headers })).json().rows.find((row: { id: string }) => row.id === submitted.json().id);
  assert.equal(row.state, "completed"); assert.equal(row.applied, false); assert.equal(row.rules.source, "latest");
  assert.deepEqual(row.rules.skills, input.snapshot.skills);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), original);
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload })).json().id, submitted.json().id);
  assert.equal(writingRequests.length, before + 2);
});

test("采纳最新Skill修订后当前稿记录实际规则，旧正文版本保留原Skill且重复采纳不再新增版本", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/writing-skills", headers, payload: { name: "规则版本归属校验", body: "第一版先讲问题，再展示步骤。", columnIds: ["practice"], enabled: true } });
  assert.equal(added.statusCode, 200); const skill = added.json();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: "规则随明确采纳切换" } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`;
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: { spoken: body, production: "原制作方案", notes: "原备注" } } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/writing-skills/${skill.id}`, headers, payload: { version: 1, body: "第二版用具体镜头对照开场，操作后说明限制。" } })).statusCode, 200);
  const submitted = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload: { requestId: randomUUID(), version: 2, field: "spoken", instruction: "明确采用当前规则，保留事实和出处", useLatestSkills: true } });
  assert.equal(submitted.statusCode, 200); const revisionId = submitted.json().id;
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const revision = (await app.inject({ url: endpoint + "/revisions", headers })).json().rows.find((row: { id: string }) => row.id === revisionId);
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), original);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${revisionId}/apply`, headers, payload: { version: 2 } })).statusCode, 200);
  const current = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(current.version, 3); assert.equal(current.content.spoken, revisionText); assert.equal(current.state, "draft");
  assert.deepEqual(current.snapshot.skills, revision.rules.skills);
  assert.ok(current.snapshot.skills.some((rule: { id: string; version: string }) => rule.id === skill.id && rule.version === "2"));
  assert.deepEqual(current.snapshot.materials, original.snapshot.materials);
  const oldVersion = (await app.inject({ url: endpoint + "/versions/2", headers })).json();
  assert.equal(oldVersion.content.spoken, body); assert.deepEqual(oldVersion.skills, original.snapshot.skills);
  assert.deepEqual((await app.inject({ url: endpoint + "/versions/3", headers })).json().skills, revision.rules.skills);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${revisionId}/apply`, headers, payload: { version: 3 } })).json().applied, false);
  assert.equal((await app.inject({ url: endpoint + "/versions", headers })).json().total, 3);
});

test("新规则下的保存复制和导出保留实际版本，恢复旧正文时规则也恢复且新旧稿件互不改写", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const skill = (await app.inject({ method: "POST", url: "/api/admin/studio/writing-skills", headers, payload: { name: "恢复规则的历史上下文", body: "旧规范先说制作问题，再讲步骤。", columnIds: ["practice"], enabled: true } })).json();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: "恢复规则上下文" } });
  assert.equal(created.statusCode, 200); const endpoint = `/api/admin/studio/drafts/${created.json().id}`, content = { spoken: body, production: "保留原制作方案", notes: "" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/writing-skills/${skill.id}`, headers, payload: { version: 1, body: "新规范先做两镜头对比，再解释条件。" } })).statusCode, 200);
  const submitted = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload: { requestId: randomUUID(), version: 2, field: "spoken", instruction: "采用当前规则形成对比稿", useLatestSkills: true } });
  assert.equal(submitted.statusCode, 200);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
  assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${submitted.json().id}/apply`, headers, payload: { version: 2 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 3, content: { ...content, spoken: "明确采纳新规范后的手动修改。" } } })).statusCode, 200);
  const calls = writingRequests.length;
  const copyLatest = await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { requestId: randomUUID(), version: 4 } });
  assert.equal(copyLatest.statusCode, 200); const copiedEndpoint = `/api/admin/studio/drafts/${copyLatest.json().id}`;
  const latestCopy = (await app.inject({ url: copiedEndpoint, headers })).json();
  assert.equal(latestCopy.snapshot.skills.find((rule: { id: string }) => rule.id === skill.id).version, "2");
  const { unzipSync, strFromU8 } = await import("fflate");
  const exportSkill = async (version: number) => {
    const result = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version, mode: "draft" } });
    assert.equal(result.statusCode, 200); const files = unzipSync(result.rawPayload), manifest = Object.keys(files).find(name => name.endsWith("/manifest.json"));
    assert.ok(manifest); return JSON.parse(strFromU8(files[manifest]!)).skills.find((rule: { id: string }) => rule.id === skill.id).version;
  };
  assert.equal(await exportSkill(4), "2");
  const restored = await app.inject({ method: "POST", url: endpoint + "/restore", headers, payload: { version: 4, restoreVersion: 2 } });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().version, 5); assert.deepEqual(restored.json().content, content);
  assert.equal(restored.json().snapshot.skills.find((rule: { id: string }) => rule.id === skill.id).version, "1");
  assert.deepEqual((await app.inject({ url: endpoint, headers })).json().snapshot.skills, original.snapshot.skills);
  assert.deepEqual((await app.inject({ url: endpoint + "/versions/5", headers })).json().skills, original.snapshot.skills);
  assert.equal((await app.inject({ url: endpoint + "/versions/4", headers })).json().skills.find((rule: { id: string }) => rule.id === skill.id).version, "2");
  assert.deepEqual((await app.inject({ url: copiedEndpoint, headers })).json(), latestCopy);
  assert.equal(await exportSkill(5), "1");
  const copyOld = await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { requestId: randomUUID(), version: 5 } });
  assert.equal(copyOld.statusCode, 200); assert.deepEqual((await app.inject({ url: `/api/admin/studio/drafts/${copyOld.json().id}`, headers })).json().snapshot.skills, original.snapshot.skills);
  assert.equal(writingRequests.length, calls);
});

test("采纳弹窗可读取未收录新闻并冻结到独立新稿，等待期间回车不另建任务，桌面窄屏不影响历史批次", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { newsImportQueue } = await import("../backend/news-imports.ts");
  // Reuse the already reviewed public fixture; this seam is reference import/adoption,
  // not another unrelated sweep of older pending material-analysis queue jobs.
  const existing = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  assert.equal(existing.recommendationState, "reviewed");
  const batch = { batchId: existing.id }, previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true; config.siteUrl = "http://127.0.0.1";
  const extraBody = "补充原稿：先保存一份固定角色参考，在近景与远景中对照脸型、衣服和光线；只改变一个条件，记录结果和限制，不保证所有模型都能保持一致。".repeat(5);
  const news = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<html><head><title>新闻补充样本${request.url}</title></head><body><article><h1>新闻补充样本${request.url}</h1><p>${extraBody}</p></article></body></html>`);
  });
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = http.createServer((request, response) => {
    const upstream = http.request(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch();
  const origin = await listenHttpForFetch(news);
  const context = await browser.newContext(), page = await context.newPage();
  const projects: string[] = [];
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`${web.origin}/admin/studio/topics/batches/${batch.batchId}`);
      if (await page.locator('input[name="password"]').isVisible()) { await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click(); }
      await page.getByLabel("栏目选题", { exact: true }).getByRole("button").filter({ hasText: "角色参考怎么用" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "采纳并写稿", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "采纳选题，建立独立稿件" }); await expect(dialog).toBeVisible();
      await dialog.getByText("增加博主作品或新闻原稿", { exact: true }).click();
      await dialog.getByLabel("链接类型", { exact: true }).selectOption("news");
      const input = dialog.getByRole("textbox", { name: "搜索或导入参考材料", exact: true });
      await input.fill(`${origin}/${width}`);
      let submissions = 0;
      const count = (request: import("@playwright/test").Request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/admin/studio/news-imports") submissions++; };
      page.on("request", count);
      await dialog.getByRole("button", { name: "搜索或读取", exact: true }).click();
      await expect(dialog).toContainText("新闻原稿已排队");
      await input.fill(`${origin}/must-not-submit-${width}`); await input.press("Enter"); await page.waitForTimeout(150);
      assert.equal(submissions, 1, "等待中回车不能绕过按钮禁用再创建另一任务"); page.off("request", count);
      await expect(dialog.getByRole("button", { name: "建立稿件并进入写稿台", exact: true })).toBeDisabled();
      const boss = await getBoss(), [job] = await boss.fetch(newsImportQueue.name); assert.ok(job);
      await newsImportQueue.run([job.data] as never[]); await boss.complete(newsImportQueue.name, job.id);
      await expect(dialog).toContainText(`已加入：新闻补充样本/${width}`, { timeout: 8000 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await fs.mkdir(".impeccable/review", { recursive: true });
      await page.screenshot({ path: `.impeccable/review/news-import-reference-${width}.png`, fullPage: true });
      await dialog.getByRole("button", { name: "建立稿件并进入写稿台" }).click();
      await expect(page.getByRole("heading", { name: "编辑稿件", exact: true })).toBeVisible();
      const projectId = new URL(page.url()).pathname.split("/").at(-1)!; projects.push(projectId);
      const draft = (await app.inject({ url: `/api/admin/studio/drafts/${projectId}`, headers })).json();
      assert.equal(draft.snapshot.supplementalMaterialIds.length, 1);
      assert.ok(draft.snapshot.materials.find((item: { title: string }) => item.title === `新闻补充样本/${width}`).body.includes(extraBody));
      assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${batch.batchId}/materials`, headers })).json().total, 1);
    }
    assert.notEqual(projects[0], projects[1]);
    const first = (await app.inject({ url: `/api/admin/studio/drafts/${projects[0]}`, headers })).json();
    assert.ok(!JSON.stringify(first.snapshot.materials).includes("新闻补充样本/390"));
  } finally { config.allowPrivateNetworkFetch = previousPrivate; await browser.close(); await web.stop(); await new Promise<void>(resolve => news.close(() => resolve())); }
});

test("旧稿网页可明确选最新Skill改稿，采纳前后及历史对比展示各自真实规则且窄屏可操作", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const drafts = "/api/admin/studio/drafts", skills = "/api/admin/studio/writing-skills";
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const added = await app.inject({ method: "POST", url: skills, headers, payload: { name: "网页明确选择的规则", body: "旧版先说明镜头问题。", columnIds: ["practice"], enabled: true } });
  assert.equal(added.statusCode, 200); const skill = added.json();
  const created = await app.inject({ method: "POST", url: drafts, headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title: "网页明确采用新规则" } });
  assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `${drafts}/${id}`;
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content: { spoken: body, production: "制作方案保持独立", notes: "" } } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `${skills}/${skill.id}`, headers, payload: { version: 1, body: "新版先用两个镜头对照，再解释适用条件。" } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json(), calls = writingRequests.length;
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { chromium, expect } = await import("@playwright/test");
  const { request: forwardRequest } = await import("node:http");
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server);
  const api = http.createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${web.origin}/admin/studio/writing/${id}`); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await page.getByRole("button", { name: "AI 改稿", exact: true }).click();
    const panel = page.getByRole("region", { name: "AI主动改稿" }), choice = panel.getByRole("checkbox", { name: "采用当前启用的最新写作 Skill" });
    await expect(choice).not.toBeChecked(); await expect(panel).toContainText("默认沿用本稿已记录的规则");
    assert.equal(writingRequests.length, calls);
    await choice.check(); await panel.getByRole("textbox", { name: "改稿要求", exact: true }).fill("采用新规则精炼口播，保留来源限制。");
    const submitted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === endpoint + "/revisions");
    await panel.getByRole("button", { name: "生成整稿修改建议", exact: true }).click();
    const response = await submitted; assert.equal(response.status(), 200); assert.equal(response.request().postDataJSON().useLatestSkills, true);
    const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!, boss = await getBoss(), [job] = await boss.fetch(queue.name);
    assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await panel.getByRole("button", { name: "刷新改稿状态", exact: true }).click();
    const proposal = panel.locator(":scope > details"); await expect(proposal).toContainText("待比较"); await proposal.locator(":scope > summary").click();
    const rules = panel.getByRole("group", { name: "本次改稿冻结的最新规则", exact: true }); await rules.locator(":scope > summary").click();
    await rules.getByText("网页明确选择的规则 · v2", { exact: true }).click(); await expect(rules.getByText("新版先用两个镜头对照，再解释适用条件。", { exact: true })).toBeVisible();
    assert.deepEqual((await app.inject({ url: endpoint, headers })).json(), original);
    await fs.mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await choice.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/writing-latest-skills-${suffix}.png` });
    }
    await proposal.getByRole("button", { name: "采纳并保存为新版本", exact: true }).click();
    await expect(proposal).toContainText("已采纳");
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "写作依据", exact: true }).click();
    const currentRules = page.getByRole("group", { name: "本稿写作规则", exact: true }); await currentRules.locator(":scope > summary").click();
    await expect(currentRules.getByText("网页明确选择的规则 · v2", { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "修改历史", exact: true }).click();
    await page.getByRole("button", { name: "版本 2 · 草稿保存", exact: true }).click();
    const history = page.getByRole("region", { name: "历史版本对比", exact: true }), oldRules = history.getByRole("group", { name: "此版本写作规则", exact: true });
    await oldRules.locator(":scope > summary").click(); await expect(oldRules.getByText("网页明确选择的规则 · v1", { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "恢复为新的草稿版本", exact: true }).click();
    await expect(history).toHaveCount(0); await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click(); await page.getByRole("button", { name: "写作依据", exact: true }).click(); await expect(currentRules.getByText("网页明确选择的规则 · v1", { exact: true })).toBeVisible();
    assert.equal((await app.inject({ url: endpoint, headers })).json().content.spoken, body);
    assert.equal(writingRequests.length, calls + 2);
  } finally { await browser.close(); await web.stop(); }
});

test("采纳新规则修订后再明确采用旧初稿提案，正文版本复制和导出必须记回旧初稿实际规则", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const drafts = "/api/admin/studio/drafts", skills = "/api/admin/studio/writing-skills";
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=1", headers })).json().rows[0];
  const added = await app.inject({ method: "POST", url: skills, headers, payload: { name: "旧初稿不能冒充新规则", body: "第一版先讲问题，再展示步骤。", columnIds: ["practice"], enabled: true } });
  assert.equal(added.statusCode, 200); const skill = added.json();
  const created = await app.inject({ method: "POST", url: drafts, headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const endpoint = `${drafts}/${created.json().id}`;
  const content = { spoken: body, production: "原来的制作方案", notes: "" };
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 1, content } })).statusCode, 200);
  const original = (await app.inject({ url: endpoint, headers })).json();
  assert.equal((await app.inject({ method: "POST", url: endpoint + "/generation", headers, payload: { version: 2 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: 2, content: { ...content, spoken: "生成期间的手动正文。" } } })).statusCode, 200);
  const { writingGenerationQueue } = await import("../backend/writing-generation.ts"), boss = await getBoss(), [generationJob] = await boss.fetch(writingGenerationQueue.name);
  assert.ok(generationJob); await writingGenerationQueue.run([generationJob.data] as never[]); await boss.complete(writingGenerationQueue.name, generationJob.id);
  const proposal = (await app.inject({ url: endpoint + "/generation", headers })).json();
  assert.equal(proposal.state, "proposal"); assert.equal(proposal.result.applied, false);
  assert.equal((await app.inject({ method: "PATCH", url: `${skills}/${skill.id}`, headers, payload: { version: 1, body: "第二版用两个镜头对照开场，再讲条件。" } })).statusCode, 200);
  const revision = await app.inject({ method: "POST", url: endpoint + "/revisions", headers, payload: { requestId: randomUUID(), version: 3, field: "spoken", instruction: "采用最新规则修改，保留事实", useLatestSkills: true } });
  assert.equal(revision.statusCode, 200);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!, [revisionJob] = await boss.fetch(queue.name);
  assert.ok(revisionJob); await queue.run([revisionJob.data] as never[]); await boss.complete(queue.name, revisionJob.id);
  assert.equal((await app.inject({ method: "POST", url: endpoint + `/revisions/${revision.json().id}/apply`, headers, payload: { version: 3 } })).statusCode, 200);
  const newer = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(newer.version, 4); assert.equal(newer.snapshot.skills.find((rule: { id: string }) => rule.id === skill.id).version, "2");
  const calls = writingRequests.length;
  const applied = await app.inject({ method: "POST", url: endpoint + `/generation/${proposal.id}/apply`, headers, payload: { version: 4 } });
  assert.equal(applied.statusCode, 200); assert.equal(applied.json().version, 5);
  const current = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(current.content.spoken, proposal.result.content.spoken);
  assert.equal(current.snapshot.skills.find((rule: { id: string }) => rule.id === skill.id).version, "1");
  assert.deepEqual(current.snapshot.skills, original.snapshot.skills);
  assert.deepEqual((await app.inject({ url: endpoint + "/versions/4", headers })).json().skills, newer.snapshot.skills);
  assert.deepEqual((await app.inject({ url: endpoint + "/versions/5", headers })).json().skills, original.snapshot.skills);
  const copied = await app.inject({ method: "POST", url: endpoint + "/copy", headers, payload: { requestId: randomUUID(), version: 5 } });
  assert.equal(copied.statusCode, 200); assert.deepEqual((await app.inject({ url: `${drafts}/${copied.json().id}`, headers })).json().snapshot.skills, original.snapshot.skills);
  const exported = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: 5, mode: "draft" } });
  assert.equal(exported.statusCode, 200); const { unzipSync, strFromU8 } = await import("fflate"), files = unzipSync(exported.rawPayload);
  const manifest = Object.keys(files).find(name => name.endsWith("/manifest.json")); assert.ok(manifest);
  assert.equal(JSON.parse(strFromU8(files[manifest]!)).skills.find((rule: { id: string }) => rule.id === skill.id).version, "1");
  assert.equal(writingRequests.length, calls);
});

test("dbskill与Humanizer联合冻结到新稿，停用改版只影响后续稿，生成改稿不增加模型步骤", async () => {
  config.modelCallsEnabled = true; await resources.warm();
  const batch = (await app.inject({ url: "/api/admin/studio/topic-batches?limit=100", headers })).json().rows
    .find((row: { recommendationState: string }) => row.recommendationState === "reviewed");
  assert.ok(batch);
  const drafts = "/api/admin/studio/drafts", skills = "/api/admin/studio/writing-skills", skillUrl = skills + "/dbskill-spoken";
  const baseline = (await app.inject({ url: skillUrl + "/versions/1", headers })).json();
  assert.equal(baseline.enabled, true); assert.equal(baseline.builtin, true);
  assert.ok(baseline.body.includes("标题独立可懂")); assert.ok(baseline.body.includes("dontbesilent"));
  const create = async (title: string) => {
    const response = await app.inject({ method: "POST", url: drafts, headers, payload: { requestId: randomUUID(), batchId: batch.id, directionIds: ["reference"], title } });
    assert.equal(response.statusCode, 200, response.body);
    return (await app.inject({ url: drafts + "/" + response.json().id, headers })).json<WritingProject>();
  };
  const first = await create("联合旧版本"), frozen = first.snapshot.skills;
  assert.ok(frozen.some(rule => rule.id === "humanizer-zh"));
  assert.ok(frozen.some(rule => rule.id === "dbskill-spoken" && rule.version === "1" && rule.body === baseline.body));
  assert.equal((await app.inject({ method: "PATCH", url: skillUrl, headers, payload: { version: 1, enabled: false } })).statusCode, 200);
  const disabled = await create("停用后独立稿"); assert.ok(!disabled.snapshot.skills.some(rule => rule.id === "dbskill-spoken"));
  const changed = await app.inject({ method: "PATCH", url: skillUrl, headers, payload: { version: 2, enabled: true, columnIds: ["models"], body: "仅模型栏目使用的新规则。" } });
  assert.equal(changed.statusCode, 200);
  assert.ok(!(await create("其他栏目不套用")).snapshot.skills.some(rule => rule.id === "dbskill-spoken"));
  const restore = await app.inject({ method: "POST", url: skillUrl + "/restore", headers, payload: { version: 3, sourceVersion: 1 } });
  assert.equal(restore.statusCode, 200, restore.body); assert.equal(restore.json().version, 4);
  const fresh = await create("恢复后联合新稿"); assert.ok(fresh.snapshot.skills.some(rule => rule.id === "dbskill-spoken" && rule.version === "4"));
  assert.deepEqual((await app.inject({ url: drafts + "/" + first.id, headers })).json().snapshot.skills, frozen);
  const callsBeforeRead = writingRequests.length;
  assert.equal((await app.inject({ url: skillUrl + "/versions?limit=1&page=4", headers })).json().rows[0].body, baseline.body);
  await app.inject({ url: drafts + "/" + disabled.id, headers }); assert.equal(writingRequests.length, callsBeforeRead);
  const boss = await getBoss(), { writingGenerationQueue } = await import("../backend/writing-generation.ts");
  for (const project of [first, fresh]) {
    const url = drafts + "/" + project.id, before = writingRequests.length;
    const submit = await app.inject({ method: "POST", url: url + "/generation", headers, payload: { version: 1 } }); assert.equal(submit.statusCode, 200, submit.body);
    const [job] = await boss.fetch(writingGenerationQueue.name); assert.ok(job); await writingGenerationQueue.run([job.data] as never[]); await boss.complete(writingGenerationQueue.name, job.id);
    const calls = writingRequests.slice(before); assert.deepEqual(calls.map(call => call.task), ["writing_draft", "writing_polish", "writing_check"]);
    assert.deepEqual((calls[0]!.snapshot as WritingProject["snapshot"]).skills, project.snapshot.skills);
    assert.deepEqual(calls[1]!.skills, project.snapshot.skills);
    assert.equal((await app.inject({ url: url + "/generation", headers })).json().quality, "checked");
    await writingGenerationQueue.run([job.data] as never[]); assert.equal(writingRequests.length, before + 3);
  }
  const revisionQueue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.writing.revise")!;
  const url = drafts + "/" + first.id;
  for (const latest of [false, true]) {
    const before = writingRequests.length;
    const submitted = await app.inject({ method: "POST", url: url + "/revisions", headers,
      payload: { requestId: randomUUID(), version: 2, field: "spoken", instruction: "让段落衔接自然，保留事实与限制。", ...(latest ? { useLatestSkills: true } : {}) } });
    assert.equal(submitted.statusCode, 200, submitted.body); const [job] = await boss.fetch(revisionQueue.name); assert.ok(job);
    await revisionQueue.run([job.data] as never[]); await boss.complete(revisionQueue.name, job.id);
    const calls = writingRequests.slice(before); assert.deepEqual(calls.map(call => call.task), latest ? ["writing_revision"] : ["writing_revision", "writing_revision_check"],
      "仅规则版本改变，事实/正文/标题相同的复核可以复用原回执");
    const actual = (calls[0]!.project as WritingProject).snapshot.skills;
    assert.ok(actual.some(rule => rule.id === "humanizer-zh"));
    assert.equal(actual.find(rule => rule.id === "dbskill-spoken")!.version, latest ? "4" : "1");
    const revision = (await app.inject({ url: url + "/revisions", headers })).json().rows.find((row: { id: string }) => row.id === submitted.json().id);
    assert.equal(revision.state, "completed"); assert.equal(revision.result.checked, true);
  }
  assert.deepEqual((await app.inject({ url, headers })).json().snapshot.skills, frozen);
});
