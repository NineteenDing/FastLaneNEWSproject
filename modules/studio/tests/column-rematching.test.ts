import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
type ExternalInput = { task?: string; columns: Array<{ id: string }>; material?: { body: string };
  understanding?: { shared: { facts: Array<{ quotes: string[] }> } } };
const inputs: ExternalInput[] = [];
let nullBenefit = false, needsBody = false, rejectPractice = false;
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content); inputs.push(input);
  const quote = input.material?.body ?? input.understanding?.shared?.facts[0].quotes[0];
  const related = !quote.includes("足球");
  const archived = related && quote.includes("暂归档");
  const output = input.task === "match_columns" && needsBody && !input.material ? { needsBody: true, matches: [] }
    : input.task === "match_columns" ? { needsBody: false, matches: input.columns.map((column: { id: string }) => ({
    columnId: column.id, value: rejectPractice && column.id === "practice" ? 0 : 95, reason: "满足新的连续镜头演示要求", viewerBenefit: nullBenefit ? null : "按新标准检查连续镜头", evidenceQuotes: [quote],
  })) } : {
    columnId: related && !archived ? "models" : "other", disposition: related && !archived ? "support" : "not_topic", summary: quote, reason: "材料实际范围", viewerBenefit: related && !archived ? "了解角色参考限制" : null,
    event: null, evidenceQuotes: [quote], entities: [], gates: { audience: related, evidence: true, benefit: related && !archived },
    dimensions: { audience: related ? 90 : 0, practical: related ? 70 : 0, evidence: 85, freshness: null, demand: null, distinctiveness: 70 },
    shared: { scope: related ? "direct" : "unrelated", scopeReason: "依正文范围", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: related ? 80 : 0, reason: "对实际创作的作用" }, interest: { value: 60, reason: "内容兴趣" }, substance: { value: 80, reason: "有明确说明" } },
      columnMatches: related && !archived ? [{ columnId: "models", value: 80, reason: "工具能力与限制" }] : [], event: null,
      reportingKind: "original", memeEvidence: [] },
  };
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
async function drain() { const boss = await getBoss(); for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) return;
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); } }
async function analysis(id: string) { return (await app.inject({ url: `/api/admin/studio/topic-batches/${id}/analysis`, headers })).json(); }
let originalBatch = "";
let filmMaterialId = "";
async function revise() {
  const columns = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows;
  const response = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${originalBatch}/versions`, headers,
    payload: { columns: columns.map(({ id, version }: { id: string; version: number }) => ({ id, version })) } });
  assert.equal(response.statusCode, 200, response.body); return response.json().batchId as string;
}
async function edit(id: string, changes: Record<string, unknown>) {
  const columns = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows;
  const response = await app.inject({ method: "PATCH", url: `/api/admin/studio/columns/${id}`, headers,
    payload: { version: columns.find((column: { id: string }) => column.id === id).version, ...changes } });
  assert.equal(response.statusCode, 200, response.body);
}

test("修改一个栏目标准只重判相关材料的该栏目，复用事实且不改原批次", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "column-match-test-key", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "column-match-source", name: "栏目匹配测试", kind: "rss", config: { feedUrl: "https://column-match.example/feed" },
  } })).statusCode, 200);
  for (const [id, body] of [["film", "角色参考工具新增连续镜头控制，只支持单人场景。"], ["sport", "足球比赛今晚开始，尚未公布出场名单。"]])
    await upsertMaterial({ sourceId: "column-match-source", title: id, url: `https://column-match.example/${id}`, via: "import",
      discoveredAt: new Date("2026-10-17T10:00:00Z"), publishedAt: new Date("2026-10-17T09:00:00Z"), bodyText: body!, bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); originalBatch = frozen.json().batch.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${originalBatch}/analysis`, headers, payload: {} })).statusCode, 200);
  await drain(); assert.equal(inputs.length, 2); const before = await analysis(originalBatch);
  filmMaterialId = before.rows.find((row: { columnId: string }) => row.columnId === "models").materialId;
  const changed = await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers,
    payload: { version: 1, requirements: "优先提供连续镜头控制的演示与明确限制。" } });
  assert.equal(changed.statusCode, 200, changed.body);
  const columns = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows;
  const next = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${originalBatch}/versions`, headers,
    payload: { columns: columns.map(({ id, version }: { id: string; version: number }) => ({ id, version })) } });
  assert.equal(next.statusCode, 200, next.body); await drain();
  assert.equal(inputs.filter(input => !input.task).length, 2, "规则变化不重新分析全部正文和事实");
  const matching = inputs.filter(input => input.task === "match_columns"); assert.equal(matching.length, 1, "不重判固定范围外的足球内容");
  assert.deepEqual(matching[0]!.columns.map((column: { id: string }) => column.id), ["practice"]);
  assert.equal(matching[0]!.material?.body, undefined, "先复用已有事实，不重复发送完整正文");
  const after = await analysis(next.json().batchId), film = after.rows.find((row: { materialId: string }) => row.materialId === before.rows.find((row: { columnId: string }) => row.columnId === "models").materialId);
  assert.equal(film.columnId, "practice"); assert.equal(film.shared.columnMatches.find((match: { columnId: string }) => match.columnId === "models").value, 80);
  assert.deepEqual(film.shared.facts, before.rows.find((row: { columnId: string }) => row.columnId === "models").shared.facts);
  assert.deepEqual(await analysis(originalBatch), before);
});

test("栏目改名与排序不收费；新标准未给出观看收益时不能沿用旧标准的收益", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const before = inputs.length;
  await edit("practice", { name: "连续镜头实操", sortOrder: 15 });
  const renamed = await revise(); await drain(); assert.equal(inputs.length, before);
  const renamedFilm = (await analysis(renamed)).rows.find((row: { columnId: string }) => row.columnId === "practice");
  assert.equal(renamedFilm.columnSnapshot.name, "连续镜头实操");
  nullBenefit = true;
  try {
    await edit("practice", { requirements: "要求有多机位演示和可验证的观看收益。" });
    const changed = await revise(); await drain();
    const film = (await analysis(changed)).rows.find((row: { columnId: string }) => row.columnId === "practice");
    assert.equal(film.viewerBenefit, null, "不能从旧标准继承已被新判断否定的收益");
    assert.equal(film.gates.benefit, false); assert.equal(film.score.eligible, false);
  } finally { nullBenefit = false; }
});

test("匹配已付费但回存中断，其他栏目继续变更后恢复仍使用原请求和回执", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  await edit("practice", { requirements: "优先拆解连续镜头的参数与失败边界。" });
  const interrupted = await revise(), boss = await getBoss();
  let selected: NonNullable<Awaited<ReturnType<typeof boss.fetch>>>[number] | undefined;
  for (;;) {
    const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    if ((job.data as { materialId: string }).materialId === filmMaterialId) { selected = job; break; }
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
  }
  const beforeInterrupted = inputs.length;
  await sql.unsafe(`CREATE FUNCTION reject_column_cache_save() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'column-cache-save-refused'; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_column_cache BEFORE INSERT ON studio_material_analysis_cache FOR EACH ROW EXECUTE FUNCTION reject_column_cache_save()");
  try {
    await assert.rejects(topicAnalysisQueue.run([selected.data] as never[]), /column-cache-save-refused/);
    await boss.cancel(topicAnalysisQueue.name, selected.id);
  } finally {
    await sql.unsafe("DROP TRIGGER reject_column_cache ON studio_material_analysis_cache");
    await sql.unsafe("DROP FUNCTION reject_column_cache_save()");
  }
  assert.equal(inputs.length, beforeInterrupted + 1, "中断前外部模型已实际返回本次匹配");
  await drain();
  assert.equal((await analysis(interrupted)).rows.filter((row: { state: string }) => row.state === "failed").length, 1);
  await edit("practice", { requirements: "优先实际测试连续镜头的复现成本。" });
  await edit("news", { requirements: "优先明确新闻对影视制作成本的影响。" });
  await revise(); await drain();
  const before = inputs.length;
  const retry = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${interrupted}/analysis`, headers, payload: { retryFailed: true } });
  assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().queuedCount, 1); await drain();
  assert.equal((await analysis(interrupted)).analyzed, 2);
  assert.equal(inputs.length, before, "不能因后来缓存或栏目变化而再次购买原本已完成的匹配");
});

test("新标准扩大后原未成题材料能重新合格，摘要不足最多补一次正文", async t => {
  const previousBatch = originalBatch;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") }); await resources.warm();
  const added = await upsertMaterial({ sourceId: "column-match-source", title: "暂归档的流程提示", url: "https://column-match.example/archived",
    via: "import", discoveredAt: new Date("2026-10-19T10:00:00Z"), publishedAt: new Date("2026-10-19T09:00:00Z"),
    bodyText: "暂归档：角色参考工具支持单人连续镜头，尚需明确操作步骤。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-18T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); originalBatch = frozen.json().batch.id;
  await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${originalBatch}/analysis`, headers, payload: {} }); await drain();
  const before = await analysis(originalBatch); assert.equal(before.rows[0].disposition, "not_topic");
  const calls = inputs.length, fullCalls = inputs.filter(input => !input.task).length;
  needsBody = true;
  try {
    await edit("practice", { requirements: "也接受能说明限制的工具能力提示，不强制完整操作步骤。" });
    const version = await revise(); await drain();
    const reading = (await analysis(version)).rows.find((row: { materialId: string }) => row.materialId === `news:${added.articleId}`);
    assert.equal(reading.columnId, "practice"); assert.equal(reading.disposition, "support"); assert.equal(reading.score.eligible, true);
    assert.equal(inputs.length, calls + 2); assert.equal(inputs.filter(input => !input.task).length, fullCalls);
    assert.equal(inputs[calls]!.material, undefined); assert.ok(inputs[calls + 1]!.material?.body.includes("暂归档"));
    assert.deepEqual(await analysis(originalBatch), before);
  } finally { needsBody = false; originalBatch = previousBatch; }
});

test("收紧仍启用的主栏目后，转入旧副栏目必须核对接收收益，不能借旧主栏收益通过", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm();
  const frozen = await analysis(originalBatch), before = inputs.length;
  rejectPractice = true; nullBenefit = true;
  try {
    await edit("practice", { requirements: "必须有多人运动镜头的完整复现实测，否则不匹配。" });
    const version = await revise(); await drain();
    const film = (await analysis(version)).rows.find((row: { materialId: string }) => row.materialId === filmMaterialId);
    assert.equal(film.columnId, "news"); assert.equal(film.viewerBenefit, null);
    assert.equal(film.gates.benefit, false); assert.equal(film.score.eligible, false);
    assert.ok(inputs.slice(before).some(input => input.columns.some(column => column.id === "news")));
    assert.deepEqual(await analysis(originalBatch), frozen);
  } finally { rejectPractice = false; nullBenefit = false; }
});

