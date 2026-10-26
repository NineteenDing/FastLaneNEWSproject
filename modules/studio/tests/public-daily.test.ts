import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { addDays, beijingAt, beijingDate } from "@aihot/contracts/time";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
let calls = 0, dailyCalls = 0, invalidComposition = false;
const dailyPolicies: number[] = [];
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++; const body = JSON.parse(String(request.body)), input = JSON.parse(body.messages.at(-1).content);
  if (input.entries) {
    dailyCalls++; dailyPolicies.push(input.policy.version); assert.equal(body.model, "deepseek-flash");
    return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ order: invalidComposition ? [] : input.entries.map((entry: { itemId: string }) => entry.itemId),
      leadParagraph: input.entries[0].summary, overview: "本期关注角色制作工具的能力与限制。" }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
  }
  const quote = input.material.body;
  const practical = quote.includes("头条候选") ? 70 : quote.includes("广泛讨论") ? 40 : quote.includes("普通更新") ? 60 : 95;
  const hot = quote.includes("广泛讨论"), at = quote.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)?.[0];
  const reuse = /^(有效背景|有效政策|过期政策)/.test(quote) ? { kind: quote.startsWith("有效背景") ? "background" : "policy",
    validFrom: null, validThrough: quote.match(/有效期至(\d{4}-\d{2}-\d{2})/)?.[1] ?? null, quotes: [quote] } : undefined;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: quote, reason: "影视工具变化", viewerBenefit: "判断角色制作条件", event: null,
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 95, practical: 95, evidence: 95, freshness: null, demand: null, distinctiveness: 90 },
    shared: { scope: "direct", editorialScope: "direct_ai_film", aiCentral: true, filmRelevant: true,
      scopeReason: "影视工具能力", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: practical, reason: "可用于制作" }, interest: { value: hot ? 100 : 95, reason: "创作者关心" }, substance: { value: hot ? 100 : 95, reason: "有实际变化" } },
      impact: { value: 90, reason: "影响制作条件" },
      v2: { I: { value: hot ? 100 : 95, reason: "创作者关心" }, M: { value: 90, reason: "影响制作条件" },
        D: { value: hot ? 100 : 95, reason: "有实际变化" }, P: { value: practical, reason: "可用于制作" },
        E: { value: 95, reason: "正文明确" }, X: { value: 90, reason: "实质变化" } },
      publicSummary: quote, summaryFactIds: [0], primaryIntent: "models", majorEvent: null,
      columnMatches: [{ columnId: "models", value: 95, reason: "模型与工具" }], reportingKind: "original", memeEvidence: [],
      event: { relation: "new", candidateId: null, label: "角色控制发布", identity: quote, quotes: [quote], ...(at ? { time: { at, precision: "instant", quote } } : {}) },
      ...(reuse ? { dailyReuse: reuse } : {}) },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

// Use the most recent passed cutoff so tests after midnight do not publish future evidence.
const day = beijingDate(new Date(Date.now() - 8 * 3600000)), cutoff = beijingAt(day, "08:00");
let id = "";
const schedule = (name: string) => serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === name);

test("香港08点才出日报，模型关闭用真实摘要出刊；材料不足如实显示，重跑不改写已刊快照", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: cutoff.getTime() - 60000 });
  config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "daily-test-only", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "phase2-daily", name: "日报影视来源", kind: "rss", config: { feedUrl: "https://daily.example/rss" } } })).statusCode, 200);
  id = (await upsertMaterial({ sourceId: "phase2-daily", title: "角色工具新增参考控制", url: "https://daily.example/release", via: "import",
    publishedAt: new Date(cutoff.getTime() - 3600000), discoveredAt: new Date(cutoff.getTime() - 3600000), bodyText: "角色工具新增参考控制，仍需检查多人镜头。", bodyStatus: "ok" })).articleId;
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await schedule("studio.news.publication.schedule")!.run(); config.modelCallsEnabled = false;
  const before = calls, daily = schedule("studio.news.daily.schedule"); assert.ok(daily, "二期应有独立日报调度，不恢复原周月报链");
  await daily.run(); assert.equal((await app.inject({ url: `/api/site/reports/daily/${day}` })).statusCode, 404);
  t.mock.timers.setTime(cutoff.getTime()); await daily.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${day}` }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().metrics.totalEvents, 1); assert.equal(response.json().leadItemId, id); assert.ok(response.body.includes("不足10"));
  assert.ok(response.body.includes("角色工具新增参考控制"));
  await daily.run(); const same = await app.inject({ url: `/api/site/reports/daily/${day}` }); assert.equal(same.body, response.body);
  assert.equal(calls, before, "模型关闭、出刊和页面读取都不能额外调用模型");
  assert.deepEqual((await app.inject({ url: "/api/site/reports/weekly" })).json().items, []);
  assert.deepEqual((await app.inject({ url: "/api/site/reports/monthly" })).json().items, []);
});

test("模板日报可显式重试，一次Flash编排形成修订，重复提交/任务/页面不重复付费", async () => {
  const before = calls; config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/daily-editions/${day}/retry`, payload: {} })).statusCode, 401);
  const retry = () => app.inject({ method: "POST", url: `/api/admin/studio/daily-editions/${day}/retry`, headers, payload: {} });
  const started = await retry(); assert.equal(started.statusCode, 200, started.body); assert.equal(started.json().queued, true);
  assert.equal((await retry()).json().queued, false);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.daily.compose"); assert.ok(queue);
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const response = await app.inject({ url: `/api/site/reports/daily/${day}` }); assert.equal(response.statusCode, 200);
  assert.ok(response.body.includes("本期关注角色制作工具的能力与限制")); assert.ok(response.body.includes("不足10"));
  const status = await app.inject({ url: "/api/admin/studio/daily-editions", headers }); assert.equal(status.statusCode, 200);
  assert.equal(status.json().rows[0].state, "completed"); assert.equal(status.json().rows[0].revision, 2);
  await queue.run([job.data] as never[]); await schedule("studio.news.daily.schedule")!.run(); await retry();
  await app.inject({ url: `/api/site/reports/daily/${day}` });
  assert.equal(dailyCalls, 1); assert.equal(calls, before + 1);
});

test("日报按十个不同事件选取，优先头条实用门槛，重复报道不占第二条", async t => {
  const next = addDays(day, 1), end = beijingAt(next, "08:00"), published = new Date(end.getTime() - 3600000);
  t.mock.timers.enable({ apis: ["Date"], now: end.getTime() - 60000 }); config.modelCallsEnabled = true;
  for (let index = 0; index < 10; index++) {
    const source = `daily-hot-${index}`;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: source, name: source, kind: "rss", config: { feedUrl: `https://${source}.example/rss` } } })).statusCode, 200);
    await upsertMaterial({ sourceId: source, title: "广泛讨论的模型发布", url: `https://${source}.example/hot`, via: "import", publishedAt: published, discoveredAt: published,
      bodyText: `广泛讨论：新模型发布，制作适用条件仍不明确。${published.toISOString()}`, bodyStatus: "ok" });
  }
  for (let index = 0; index < 10; index++) await upsertMaterial({ sourceId: "phase2-daily", title: index === 0 ? "头条候选：角色工具制作方法" : `普通更新${index}：制作工具`,
    url: `https://daily.example/next-${index}`, via: "import", publishedAt: published, discoveredAt: published,
    bodyText: `${index === 0 ? "头条候选" : "普通更新"}：制作工具变化${index}，需检查使用条件。${published.toISOString()}`, bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await schedule("studio.news.publication.schedule")!.run(); config.modelCallsEnabled = false;
  const before = calls; t.mock.timers.setTime(end.getTime()); await schedule("studio.news.daily.schedule")!.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${next}` }); assert.equal(response.statusCode, 200, response.body);
  const report = response.json(), entries = [...report.sections.flatMap((section: { items: Array<{ itemId: string }> }) => section.items), ...report.flashes];
  assert.equal(report.metrics.totalEvents, 10); assert.equal(entries.length, 10); assert.equal(new Set(entries.map(entry => entry.itemId)).size, 10);
  assert.ok(report.lead.title.includes("广泛讨论"), "头条按新鲜实测热度选择，不以实用贡献门槛否决");
  assert.equal(entries.filter(entry => entry.title.includes("广泛讨论")).length, 1); assert.equal(calls, before);
});

test("不足十条按48小时未用、七天有效背景、三十天有效政策补齐并标回看，过期和普通旧闻不补", async t => {
  const date = addDays(day, 2), end = beijingAt(date, "08:00"), current = new Date(end.getTime() - 60000);
  t.mock.timers.enable({ apis: ["Date"], now: current }); config.modelCallsEnabled = true;
  for (const [name, hours, expiry] of [["当日变化", 1, null], ["未用旧闻", 30, null], ["有效背景", 72, addDays(date, 30)],
    ["有效政策", 20 * 24, addDays(date, 30)], ["过期政策", 20 * 24, addDays(date, -1)], ["普通旧闻", 10 * 24, null], ["未来新闻", -1, null]] as const) {
    const published = new Date(end.getTime() - hours * 3600000);
    await upsertMaterial({ sourceId: "phase2-daily", title: name, url: `https://daily.example/lookback-${encodeURIComponent(name)}`, via: "import",
      publishedAt: published, discoveredAt: current, bodyText: `${name}：影响影视制作条件。${published.toISOString()}${expiry ? `有效期至${expiry}` : ""}`, bodyStatus: "ok" });
  }
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  for (let turn = 0; turn < 2; turn++) await schedule("studio.news.publication.schedule")!.run(); config.modelCallsEnabled = false;
  const before = calls; t.mock.timers.setTime(end.getTime()); await schedule("studio.news.daily.schedule")!.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${date}` }); assert.equal(response.statusCode, 200);
  const report = response.json(), titles = [...report.sections.flatMap((section: { items: Array<{ title: string }> }) => section.items), ...report.flashes].map(entry => entry.title);
  for (const name of ["当日变化", "未用旧闻", "有效背景", "有效政策"]) assert.ok(titles.some(title => title.includes(name)), name);
  for (const name of ["过期政策", "普通旧闻", "未来新闻", "头条候选", "广泛讨论"]) assert.ok(!titles.some(title => title.includes(name)), name);
  for (const name of ["未用旧闻", "有效背景", "有效政策"]) assert.ok(titles.find(title => title.includes(name)).includes("回看"), name);
  assert.ok(response.body.includes("不足10")); assert.equal(calls, before);
});

test("模型编排失败保留模板，显式重试复用冻结规则和材料，成功只新增一个修订", async () => {
  const date = addDays(day, 2), before = (await app.inject({ url: `/api/site/reports/daily/${date}` })).body;
  config.modelCallsEnabled = true; invalidComposition = true;
  const retry = () => app.inject({ method: "POST", url: `/api/admin/studio/daily-editions/${date}/retry`, headers, payload: {} });
  assert.equal((await retry()).json().queued, true);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.daily.compose")!, boss = await getBoss();
  let [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  assert.equal((await app.inject({ url: `/api/site/reports/daily/${date}` })).body, before);
  let state = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(state.state, "fallback"); assert.equal(state.revision, 1); assert.ok(state.error.includes("重试"));
  const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  const changed = await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers, payload: { ...policy, public: { ...policy.public, selectedAbove: 100 } } });
  assert.equal(changed.statusCode, 200); assert.equal((await app.inject({ url: `/api/site/reports/daily/${date}` })).body, before);
  invalidComposition = false; assert.equal((await retry()).json().queued, true);
  [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  state = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(state.state, "completed"); assert.equal(state.revision, 2); assert.equal(dailyPolicies.at(-1), policy.version, "编排复用原快照，不受后续权重更改影响");
  const response = await app.inject({ url: `/api/site/reports/daily/${date}` }); assert.ok(response.body.includes("有效政策")); assert.ok(response.body.includes("回看"));
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers, payload: { ...policy, version: changed.json().policy.version } })).statusCode, 200);
});

test("日报冻结后发布写盘中断，下次调度从原快照恢复，审批与报告一起提交", async t => {
  const date = addDays(day, 3), end = beijingAt(date, "08:00");
  t.mock.timers.enable({ apis: ["Date"], now: end }); config.modelCallsEnabled = false;
  // Infrastructure fault at the actual PostgreSQL write boundary, never a domain-table fixture.
  await sql.unsafe("CREATE FUNCTION refuse_daily_report_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'daily-report-save-refused'; END $$");
  await sql.unsafe("CREATE TRIGGER refuse_daily_report_save BEFORE INSERT ON reports FOR EACH ROW EXECUTE FUNCTION refuse_daily_report_save()");
  try { await assert.rejects(schedule("studio.news.daily.schedule")!.run(), /daily-report-save-refused/); }
  finally { await sql.unsafe("DROP TRIGGER refuse_daily_report_save ON reports"); await sql.unsafe("DROP FUNCTION refuse_daily_report_save()"); }
  assert.equal((await app.inject({ url: `/api/site/reports/daily/${date}` })).statusCode, 404, "未提交的报告不应有独立审批漏出");
  const before = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(before.state, "pending");
  await schedule("studio.news.daily.schedule")!.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${date}` }); assert.equal(response.statusCode, 200, "不能因冻结行已存在而永远跳过中断的出刊");
  const after = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(after.state, "fallback"); assert.equal(after.count, before.count); assert.equal(after.revision, 1);
});

test("Flash已返回但日报修订写盘失败，重试使用原付费回执，不重复调用模型", async () => {
  const date = addDays(day, 1), before = (await app.inject({ url: `/api/site/reports/daily/${date}` })).body, paid = dailyCalls;
  config.modelCallsEnabled = true;
  const retry = () => app.inject({ method: "POST", url: `/api/admin/studio/daily-editions/${date}/retry`, headers, payload: {} });
  assert.equal((await retry()).json().queued, true);
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.daily.compose")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job);
  await sql.unsafe("CREATE FUNCTION refuse_daily_revision_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'daily-revision-save-refused'; END $$");
  await sql.unsafe("CREATE TRIGGER refuse_daily_revision_save BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION refuse_daily_revision_save()");
  try { await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id); }
  finally { await sql.unsafe("DROP TRIGGER refuse_daily_revision_save ON reports"); await sql.unsafe("DROP FUNCTION refuse_daily_revision_save()"); }
  assert.equal(dailyCalls, paid + 1); assert.equal((await app.inject({ url: `/api/site/reports/daily/${date}` })).body, before);
  assert.equal((await retry()).json().queued, true);
  const [next] = await boss.fetch(queue.name); assert.ok(next); await queue.run([next.data] as never[]); await boss.complete(queue.name, next.id);
  const state = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(state.state, "completed"); assert.equal(state.revision, 2); assert.equal(dailyCalls, paid + 1, "恢复不能再买一次已完成编排");
});

test("日报引用撤回后，依赖这些材料的综合导读也即时隐藏，历史索引和独立快照仍存在", async () => {
  const before = await app.inject({ url: `/api/site/reports/daily/${day}` }); assert.ok(before.json().overview);
  const paid = calls;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/content/${id}/visibility`, headers,
    payload: { version: 0, visibility: "withdrawn", reason: "日报原材料更正并下架" } })).statusCode, 200);
  const response = await app.inject({ url: `/api/site/reports/daily/${day}` }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().overview, null, "不能在引用已下架后继续公开由其编写的独立导读");
  assert.equal(response.json().lead, null); assert.equal(response.json().sections[0].items[0].available, false);
  assert.ok((await app.inject({ url: "/api/site/reports/daily" })).json().items.some((entry: { key: string }) => entry.key === day));
  assert.equal(calls, paid);
});

test("重启错过日期时有界补刊，新到08点的日报自动排一次Flash编排任务", async t => {
  const date = addDays(day, 5), end = beijingAt(date, "08:00"), published = new Date(end.getTime() - 3600000);
  t.mock.timers.enable({ apis: ["Date"], now: end.getTime() - 60000 }); config.modelCallsEnabled = true;
  await upsertMaterial({ sourceId: "phase2-daily", title: "自动出刊的工具更新", url: "https://daily.example/automatic", via: "import", publishedAt: published, discoveredAt: published,
    bodyText: `自动出刊的工具变化，需要检查制作条件。${published.toISOString()}`, bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  for (let turn = 0; turn < 2; turn++) await schedule("studio.news.publication.schedule")!.run();
  const paid = dailyCalls; t.mock.timers.setTime(end.getTime());
  const result = await schedule("studio.news.daily.schedule")!.run() as { created: number }; assert.equal(result.created, 2);
  assert.equal((await app.inject({ url: `/api/site/reports/daily/${addDays(day, 4)}` })).statusCode, 200, "错过的前一天也补齐归档");
  let state = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date); assert.equal(state.state, "queued");
  const queue = serverModules().find(module => module.name === "studio")!.queues!.find(item => item.name === "studio.daily.compose")!;
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  state = (await app.inject({ url: "/api/admin/studio/daily-editions", headers })).json().rows.find((row: { day: string }) => row.day === date);
  assert.equal(state.state, "completed"); assert.equal(state.revision, 2); assert.equal(dailyCalls, paid + 1);
  await schedule("studio.news.daily.schedule")!.run(); assert.equal(dailyCalls, paid + 1);
});

test("头条按新鲜实测热度产生，多个高热度事件并列时接近带内再比较新闻价值", async t => {
  const date = addDays(day, 6), end = beijingAt(date, "08:00"), published = new Date(end.getTime() - 3600000);
  t.mock.timers.enable({ apis: ["Date"], now: end.getTime() - 60000 }); config.modelCallsEnabled = true;
  for (let event = 0; event < 10; event++) for (let source = 0; source < 5; source++) {
    await upsertMaterial({ sourceId: `daily-hot-${source}`, title: `广泛讨论的新事件${event}`, url: `https://daily-hot-${source}.example/lead-boundary-${event}`, via: "import",
      publishedAt: published, discoveredAt: published, bodyText: `广泛讨论：新事件${event}影响制作，具体条件仍未明确。${published.toISOString()}`, bodyStatus: "ok" });
  }
  const title = "头条候选：完整制作条件优先";
  await upsertMaterial({ sourceId: "phase2-daily", title, url: "https://daily.example/lead-boundary", via: "import", publishedAt: published, discoveredAt: published,
    bodyText: `头条候选：新增制作步骤及使用条件。${published.toISOString()}`, bodyStatus: "ok" });
  const boss = await getBoss();
  for (let turn = 0; turn < 3; turn++) {
    await scheduleTopicMaterialAnalyses();
    for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
    await schedule("studio.news.publication.schedule")!.run();
  }
  config.modelCallsEnabled = false; const paid = calls;
  t.mock.timers.setTime(end.getTime()); await schedule("studio.news.daily.schedule")!.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${date}` }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().metrics.totalEvents, 10); assert.ok(response.json().lead.title.startsWith("广泛讨论的新事件"), "头条按新鲜实测热度选择，不被单源高分稿替代");
  const entries = [...response.json().sections.flatMap((section: { items: Array<{ itemId: string }> }) => section.items), ...response.json().flashes];
  assert.equal(new Set(entries.map(entry => entry.itemId)).size, 10); assert.equal(calls, paid);
});

test("没有优先头条且当天已有十条时，较高分旧背景不能越过补齐顺序挤掉当天事件", async t => {
  const date = addDays(day, 7), end = beijingAt(date, "08:00"), published = new Date(end.getTime() - 3600000);
  t.mock.timers.enable({ apis: ["Date"], now: end.getTime() - 60000 }); config.modelCallsEnabled = true;
  for (let index = 0; index < 10; index++) await upsertMaterial({ sourceId: "phase2-daily", title: `普通更新：当日制作事件${index}`,
    url: `https://daily.example/fallback-current-${index}`, via: "import", publishedAt: published, discoveredAt: published,
    bodyText: `普通更新：当日制作事件${index}说明条件。${published.toISOString()}`, bodyStatus: "ok" });
  const old = new Date(end.getTime() - 72 * 3600000);
  await upsertMaterial({ sourceId: "phase2-daily", title: "有效背景：不应挤掉当天事件", url: "https://daily.example/fallback-background", via: "import",
    publishedAt: old, discoveredAt: published, bodyText: `有效背景：制作流程仍有效，但不是新事件。${old.toISOString()}有效期至${addDays(date, 30)}`, bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await schedule("studio.news.publication.schedule")!.run(); config.modelCallsEnabled = false;
  const paid = calls; t.mock.timers.setTime(end.getTime()); await schedule("studio.news.daily.schedule")!.run();
  const response = await app.inject({ url: `/api/site/reports/daily/${date}` }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().metrics.totalEvents, 10); assert.ok(response.json().lead.title.startsWith("普通更新：当日"));
  assert.ok(!response.body.includes("不应挤掉当天事件")); assert.equal(calls, paid);
});

test("真实日报网页只保留日报入口，头条不在栏目重复，回看与真实不足说明在两种尺寸可读", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: beijingAt(addDays(day, 8), "09:00") });
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { mkdir } = await import("node:fs/promises"); await mkdir(".impeccable/review", { recursive: true });
  transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const before = calls, web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage();
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const offset of [1, 2]) {
        const date = addDays(day, offset), response = await page.goto(web.origin + `/daily/${date}`); assert.equal(response?.status(), 200);
        await expect(page.getByRole("link", { name: "周报", exact: true })).toHaveCount(0); await expect(page.getByRole("link", { name: "月报", exact: true })).toHaveCount(0);
        if (offset === 1) await expect(page.getByRole("heading", { name: "广泛讨论的模型发布", exact: true })).toHaveCount(1);
        else {
          await expect(page.getByLabel("本期说明", { exact: true })).toContainText("不足10");
          await expect(page.getByRole("heading", { name: /回看.*有效政策/ })).toHaveCount(1);
        }
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
        await page.screenshot({ path: `.impeccable/review/phase2-daily-${offset}-${width}.png` });
      }
    }
    const response = await page.goto(web.origin + "/daily"); assert.equal(response?.status(), 200);
    await expect(page.getByRole("heading", { level: 2, name: /^普通更新：当日/ })).toHaveCount(1);
    await page.goto(web.origin + `/daily/${addDays(day, 6)}`);
    await expect(page.getByRole("heading", { name: /^广泛讨论的新事件/ })).toHaveCount(1);
    await page.goto(web.origin + `/daily/${addDays(day, 3)}`);
    await expect(page.getByLabel("本期说明", { exact: true })).toContainText("不足10");
    assert.equal(calls, before);
  } finally { await browser.close(); await web.stop(); }
});
