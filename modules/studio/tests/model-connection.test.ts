import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { getBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { budgetStatus } from "@aihot/backend/providers/llm-budget";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
const url = "/api/admin/studio/model-connection";
const connection = { baseUrl: "https://api.deepseek.com/v1", analysisModel: "analysis-fixture", qualityModel: "quality-fixture" };
let analyzedBatchId = "";

test("私有模型连接保存后可跨请求读取但不回显Key，修改保留Key，旧窗口与清除都有版本保护", async () => {
  const initial = await app.inject({ url, headers });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().version, 0); assert.equal(initial.json().state, "missing");
  assert.equal(initial.json().verified, false);
  const saved = await app.inject({ method: "PUT", url, headers, payload: { ...connection, version: 0, apiKey: "private-model-connection-fixture-key" } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().state, "saved");
  assert.equal(saved.json().version, 1); assert.equal(saved.json().verified, false);
  assert.ok(!saved.body.includes("private-model-connection"));
  const read = await app.inject({ url, headers });
  assert.equal(read.json().qualityModel, "deepseek-flash"); assert.ok(!read.body.includes("private-model-connection"));
  const updated = await app.inject({ method: "PUT", url, headers, payload: { ...connection, version: 1, analysisModel: "analysis-second" } });
  assert.equal(updated.statusCode, 200); assert.equal(updated.json().state, "saved"); assert.equal(updated.json().version, 2);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...connection, version: 1, apiKey: "stale-fixture" } })).statusCode, 409);
  const cleared = await app.inject({ method: "PUT", url, headers, payload: { ...connection, version: 2, apiKey: "" } });
  assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().state, "missing"); assert.equal(cleared.json().version, 3);
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload: { ...connection, version: 3, apiKey: "forbidden" } })).statusCode, 403);
});

test("网页保存的模型连接实际用于持久材料分析，不改进程环境并保留模型回执和对应费率预算", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  const previous = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  const key = "private-live-model-fixture", body = "固定角色参考图，再检查光线和镜头角度。";
  let calls = 0;
  transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` } }).reply(request => {
    calls++; assert.equal(JSON.parse(String(request.body)).model, "deepseek-flash");
    return { statusCode: 200, data: JSON.stringify({ id: "model-connection-receipt-fixture", choices: [{ message: { content: JSON.stringify({
      columnId: "practice", disposition: "support", summary: "角色参考图检查流程", reason: "给出制作步骤", viewerBenefit: "减少角色漂移", event: "角色一致性制作",
      evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true },
      dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 60 },
    }) } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }) };
  });
  try {
    await resources.warm();
    const saved = await app.inject({ method: "PUT", url, headers, payload: { baseUrl: "https://api.deepseek.com/v1", analysisModel: "deepseek-flash", qualityModel: "deepseek-v4-pro", version: 3, apiKey: key } });
    assert.equal(saved.statusCode, 200); assert.equal(calls, 0, "保存与读取不访问模型");
    const priorEnvironment = { url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "model-connection-news", name: "模型连接样本", kind: "rss", config: { feedUrl: "https://model-connection.example/feed" } } })).statusCode, 200);
    await upsertMaterial({ sourceId: "model-connection-news", title: "角色一致性制作", url: "https://model-connection.example/one", via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
    const batch = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
    assert.equal(batch.statusCode, 200);
    analyzedBatchId = batch.json().batch.id;
    const analysisUrl = `/api/admin/studio/topic-batches/${batch.json().batch.id}/analysis`;
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 200);
    const before = budgetStatus();
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.material-analysis")!;
    assert.ok(queue);
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]);
    await boss.complete(queue.name, job.id);
    const result = (await app.inject({ url: analysisUrl, headers })).json();
    assert.equal(result.analyzed, 1); assert.ok(result.rows[0].receiptId > 0); assert.equal(calls, 1);
    assert.equal(budgetStatus().spentToday - before.spentToday, 10, "百万输入2元、百万输出8元的高峰估算，不套用其他模型费率");
    assert.deepEqual({ url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL }, priorEnvironment);
    assert.ok(!(await app.inject({ url, headers })).body.includes(key));
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = oldPrivate; await transport.close(); }
});

test("选题综合统一使用Flash并按Flash估算，旧Pro分路不再生效，读取结果不重复请求", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  const previous = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  let calls = 0, sentModel = "";
  transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer private-live-model-fixture" } }).reply(request => {
    calls++; const payload = JSON.parse(String(request.body)); sentModel = payload.model;
    const input = JSON.parse(payload.messages.find((message: { role: string }) => message.role === "user").content);
    const ids = input.materials.map((item: { material: { id: string } }) => item.material.id);
    return { statusCode: 200, data: JSON.stringify({ id: "quality-model-receipt-fixture", choices: [{ message: { content: JSON.stringify({
      directions: [{ id: "character-reference", columnId: "practice", eventKey: "character-reference-workflow",
        question: "连续镜头角色总变脸，先检查哪一步？", viewerBenefit: "减少分镜角色漂移", whyNow: "有可演示制作步骤",
        angle: "固定参考，再检查光线和镜头", usage: { steps: ["固定角色参考图", "检查光线和角度"], conditions: ["有可用角色图"], limitations: ["没有实测保证"] },
        titles: ["角色总变脸？先固定参考图", "连续镜头如何保住角色", "AI漫剧角色参考检查"], preferredTitle: 0,
        structure: { opening: "展示漂移问题", rhythm: "问题、操作、限制", ending: "给下一步" },
        references: ids.map((materialId: string) => ({ materialId, role: "fact", quote: "固定角色参考图，再检查光线和镜头角度。", reason: "制作步骤" })),
        dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 60 }, gates: { audience: true, evidence: true, benefit: true },
      }], assignments: ids.map((materialId: string) => ({ materialId, columnId: "practice", disposition: "support", directionIds: ["character-reference"], reason: "同一制作流程" })),
    }) } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }) };
  });
  try {
    await resources.warm();
    const recommendationUrl = `/api/admin/studio/topic-batches/${analyzedBatchId}/recommendations`;
    const submitted = await app.inject({ method: "POST", url: recommendationUrl, headers, payload: {} }); assert.equal(submitted.statusCode, 200);
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.generate")!;
    assert.ok(queue); const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    const before = budgetStatus(); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const result = await app.inject({ url: recommendationUrl, headers });
    assert.equal(result.statusCode, 200); assert.equal(result.json().result.directions.length, 1); assert.equal(calls, 1);
    assert.equal(sentModel, "deepseek-flash", "选题任务不能继续发送旧Pro模型");
    assert.equal(budgetStatus().spentToday - before.spentToday, 10);
    await app.inject({ url: recommendationUrl, headers }); assert.equal(calls, 1);
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = oldPrivate; await transport.close(); }
});

test("兼容服务同样使用Flash和自行填写的单价，不把第三方价格冒充DeepSeek官方价格", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  const previous = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  const body = "准备角色参考图，然后检查一致性。";
  let calls = 0;
  transport.get("https://model-gateway.example").intercept({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer private-compatible-model-key" } }).reply(request => {
    calls++; assert.equal(JSON.parse(String(request.body)).model, "deepseek-flash");
    return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      columnId: "practice", disposition: "support", summary: "角色参考检查", reason: "有操作步骤", viewerBenefit: "检查角色一致性", event: "参考图制作",
      evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 60 },
    }) } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }) };
  });
  try {
    const saved = await app.inject({ method: "PUT", url, headers, payload: { version: 4, baseUrl: "https://model-gateway.example/v1", apiKey: "private-compatible-model-key",
      analysisModel: "custom-analysis", qualityModel: "custom-quality", analysisPrice: { inputPerMillion: 7, outputPerMillion: 11 }, qualityPrice: { inputPerMillion: 13, outputPerMillion: 17 } } });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().analysisPrice.inputPerMillion, 7);
    await resources.warm();
    await upsertMaterial({ sourceId: "model-connection-news", title: "参考图检查流程", url: "https://model-connection.example/two", via: "import",
      discoveredAt: new Date("2026-10-19T10:00:00Z"), publishedAt: new Date("2026-10-19T09:00:00Z"), bodyText: body, bodyStatus: "ok" });
    const batch = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } }); assert.equal(batch.statusCode, 200);
    const analysisUrl = `/api/admin/studio/topic-batches/${batch.json().batch.id}/analysis`;
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 200);
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.material-analysis")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    const before = budgetStatus(); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    assert.equal((await app.inject({ url: analysisUrl, headers })).json().analyzed, 1); assert.equal(calls, 1);
    assert.equal(budgetStatus().spentToday - before.spentToday, 18);
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = oldPrivate; await transport.close(); }
});

test("配置入口拒绝不安全地址与Key注入，更换服务商需重填Key，并发保存只接纳一个版本", async () => {
  const current = (await app.inject({ url, headers })).json();
  const input = { version: current.version, baseUrl: current.baseUrl, analysisModel: current.analysisModel, qualityModel: current.qualityModel };
  for (const baseUrl of ["http://api.deepseek.com/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://169.254.169.254/", "https://user:pass@api.deepseek.com/v1", "https://api.deepseek.com/v1?key=hidden", "https://api.deepseek.com/v1/chat/completions"]) {
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...input, baseUrl, apiKey: "safe-fixture" } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...input, apiKey: "private-injection\r\nHost:evil.example" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...input, baseUrl: "https://another-provider.example/v1" } })).statusCode, 409);
  const attempts = await Promise.all(["one", "two"].map(value => app.inject({ method: "PUT", url, headers, payload: { ...input, apiKey: `private-concurrent-${value}` } })));
  assert.deepEqual(attempts.map(result => result.statusCode).sort(), [200, 409]);
  assert.equal((await app.inject({ url, headers })).json().version, current.version + 1);
});

test("服务器密钥变化明确显示模型Key不可读，模型总开关关闭时不把已保存配置当可调用", async () => {
  const secret = process.env.SESSION_SECRET, enabled = config.modelCallsEnabled;
  process.env.SESSION_SECRET = "another-model-connection-server-secret"; config.modelCallsEnabled = false;
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `username=admin&password=${config.adminPassword}` });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const csrf = (await app.inject({ url: "/api/admin/me", headers: { cookie } })).json().csrf;
    const read = await app.inject({ url, headers: { cookie } });
    assert.equal(read.statusCode, 200); assert.equal(read.json().state, "unreadable"); assert.equal(read.json().runtimeEnabled, false);
    assert.ok(!read.body.includes("private-concurrent"));
    const saved = read.json();
    assert.equal((await app.inject({ method: "PUT", url, headers: { cookie, "x-csrf-token": csrf }, payload: { version: saved.version,
      baseUrl: saved.baseUrl, analysisModel: saved.analysisModel, qualityModel: saved.qualityModel } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${analyzedBatchId}/analysis`, headers: { cookie, "x-csrf-token": csrf }, payload: {} })).statusCode, 409);
  } finally { process.env.SESSION_SECRET = secret; config.modelCallsEnabled = enabled; }
});

for (const repaired of [false, true]) test(repaired
  ? "模型正文含原始换行及Unicode转义Key时，下游能修复的JSON也必须在回执前拒绝"
  : "服务商在合法JSON中用Unicode转义回显Key也必须在持久回执前拒绝，不能把秘密当普通模型元数据", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(repaired ? "2026-10-24T12:00:00Z" : "2026-10-22T12:00:00Z") });
  const previous = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  const key = "private-unicode-echo-model-key", body = "控制光线，再检查角色参考图。";
  const response = { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "角色参考检查", reason: "制作步骤",
    viewerBenefit: "检查角色一致性", event: "角色检查", evidenceQuotes: [body], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 60 } }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 }, provider: { [key]: key } };
  const escaped = [...key].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  let raw: string;
  if (repaired) {
    const content = response.choices[0]!.message.content.replace("角色参考检查", `角色\n${escaped}`);
    raw = JSON.stringify({ choices: [{ message: { content } }], usage: response.usage });
    assert.ok(JSON.parse(raw).choices[0].message.content.includes("角色\n"));
  } else {
    raw = JSON.stringify(response).replaceAll(key, escaped);
    assert.equal(JSON.parse(raw).provider[key], key);
  }
  assert.equal(raw.includes(key), false);
  transport.get("https://model-gateway.example").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(200, raw);
  try {
    const current = (await app.inject({ url, headers })).json();
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { version: current.version, baseUrl: current.baseUrl,
      analysisModel: current.analysisModel, qualityModel: current.qualityModel, apiKey: key } })).statusCode, 200);
    await resources.warm();
    const materialDate = repaired ? "2026-10-23" : "2026-10-21";
    await upsertMaterial({ sourceId: "model-connection-news", title: "角色检查新流程", url: `https://model-connection.example/echo-${materialDate}`, via: "import",
      discoveredAt: new Date(`${materialDate}T10:00:00Z`), publishedAt: new Date(`${materialDate}T09:00:00Z`), bodyText: body, bodyStatus: "ok" });
    const batch = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: repaired ? "2026-10-22T12:00:00Z" : "2026-10-20T12:00:00Z" } }); assert.equal(batch.statusCode, 200);
    const analysisUrl = `/api/admin/studio/topic-batches/${batch.json().batch.id}/analysis`;
    assert.equal((await app.inject({ method: "POST", url: analysisUrl, headers, payload: {} })).statusCode, 200);
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.topic.material-analysis")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await assert.rejects(queue.run([job.data] as never[]), /模型服务请求失败/);
    const state = (await app.inject({ url: analysisUrl, headers })).json();
    assert.equal(state.analyzed, 0); assert.equal(state.rows[0].state, "failed");
    const runs = await app.inject({ url: "/api/admin/runs", headers });
    assert.ok(runs.json().receipts.issues.some((receipt: { subject: string; status: string }) => receipt.subject.includes(batch.json().batch.id) && receipt.status === "unknown"));
    assert.ok(!runs.body.includes(key)); assert.ok(!JSON.stringify(state).includes(key));
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = oldPrivate; await transport.close(); }
});

test("旧三路配置保存后统一为Flash和同一费率，深度分析仍须明确启用，不回填密钥", async () => {
  const before = (await app.inject({ url, headers })).json();
  const saved = await app.inject({ method: "PUT", url, headers, payload: { version: before.version, baseUrl: before.baseUrl,
    analysisModel: "deepseek-v4-pro", qualityModel: "other-expensive-model", visionModel: "legacy-vision-model",
    analysisPrice: { inputPerMillion: 2, outputPerMillion: 8 }, qualityPrice: { inputPerMillion: 9, outputPerMillion: 27 },
    visionPrice: { inputPerMillion: 15, outputPerMillion: 60 } } });
  assert.equal(saved.statusCode, 200, saved.body);
  const current = (await app.inject({ url, headers })).json();
  assert.equal(current.analysisModel, "deepseek-flash");
  assert.equal(current.qualityModel, "deepseek-flash");
  assert.equal(current.visionModel, "deepseek-flash");
  assert.deepEqual(current.qualityPrice, { inputPerMillion: 2, outputPerMillion: 8 });
  assert.deepEqual(current.visionPrice, { inputPerMillion: 2, outputPerMillion: 8 });
  assert.equal(current.state, "saved"); assert.equal(current.verified, false);
  assert.equal(saved.headers["cache-control"], "no-store");
  assert.ok(!saved.body.includes("sealedKey") && !saved.body.includes("apiKey"));
});
