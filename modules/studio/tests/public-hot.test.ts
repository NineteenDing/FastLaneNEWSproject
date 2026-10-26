import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
let calls = 0;
const ids: string[] = [];
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++;
  const quote = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content).material.body;
  const unrelated = quote.includes("足球");
  const level = quote.includes("较弱比对") ? 65 : 95;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: quote, reason: "角色制作工具新增参考控制", viewerBenefit: "判断能否改善跨镜头一致性", event: null,
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 95, practical: 95, evidence: 95, freshness: null, demand: null, distinctiveness: 90 },
    shared: { scope: unrelated ? "unrelated" : "direct", editorialScope: unrelated ? "unrelated" : "direct_ai_film",
      aiCentral: !unrelated, filmRelevant: !unrelated, scopeReason: unrelated ? "体育赛况与AI影视无关" : "影视工具更新",
      scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: 95, reason: "用于角色制作" }, interest: { value: 95, reason: "创作者关心" }, substance: { value: 95, reason: "有明确变化" } },
      impact: { value: 90, reason: "影响角色制作" },
      v2: { I: { value: level, reason: "创作者关心" }, M: { value: level, reason: "影响角色制作" }, D: { value: level, reason: "有明确变化" },
        P: { value: level, reason: "用于角色制作" }, E: { value: level, reason: "正文明确" }, X: { value: level, reason: "参考控制更新" } },
      publicSummary: quote, summaryFactIds: [0], primaryIntent: "models", majorEvent: null,
      columnMatches: [{ columnId: "models", value: 95, reason: "工具能力" }], reportingKind: "original", memeEvidence: [],
      event: { relation: "new", candidateId: null, label: unrelated ? "足球赛况" : "角色控制发布", identity: quote.includes("比对") ? quote : unrelated ? "足球赛况20261024" : "角色控制发布20261024", quotes: [quote] } },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

const schedule = (name: string) => serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === name);

test("共享新闻的热点任务沿原计算生成实际不足十条的榜单，不恢复旧编辑链或重复调用模型", async () => {
  config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "hot-test-only", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  for (let index = 0; index < 3; index++) {
    const source = `phase2-hot-${index}`;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: source, name: `公开观察${index}`, kind: "rss", config: { feedUrl: `https://${source}.example/rss` } } })).statusCode, 200);
    ids.push((await upsertMaterial({ sourceId: source, title: "角色控制更新", url: `https://${source}.example/release`, via: "import", publishedAt: new Date(),
      bodyText: "角色制作工具新增参考控制，仍需检查多人镜头。", bodyStatus: "ok" })).articleId);
  }
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await schedule("studio.news.publication.schedule")!.run();
  const hot = schedule("studio.news.hot.schedule"); assert.ok(hot, "共享处理必须启用独立本地热度任务"); await hot.run();
  const response = await app.inject({ url: "/api/site/hot" }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().entries.length, 1); assert.equal(response.json().entries[0].participantCount, 3);
  assert.equal(response.json().entries[0].sourceCount, 3); assert.equal(response.json().windowHours, 0);
  assert.equal(calls, 1, "三份相同正文只有一次基础理解，热度更新不付费");
  assert.ok(response.json().entries[0].spark.filter((point: unknown) => point !== null).length <= 1, "只有当前实测点，不补造过去走势");
});

test("多个公开新闻源报道的无关热点仍不得进入AI影视热点榜，刷新榜单不重新调用模型", async () => {
  for (let index = 0; index < 3; index++) {
    const source = `unrelated-hot-${index}`;
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
      id: source, name: `体育观察${index}`, kind: "rss", config: { feedUrl: `https://${source}.example/rss` },
    } })).statusCode, 200);
    await upsertMaterial({ sourceId: source, title: "足球赛况", url: `https://${source}.example/match`, via: "import", publishedAt: new Date(),
      bodyText: "足球比赛结束，多家媒体报道进球情况。", bodyStatus: "ok" });
  }
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  const before = calls;
  await schedule("studio.news.publication.schedule")!.run(); await schedule("studio.news.hot.schedule")!.run();
  const response = await app.inject({ url: "/api/site/hot" }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().entries.length, 1); assert.ok(!response.body.includes("足球") && !response.body.includes("体育观察"));
  assert.equal(calls, before);
});

test("非代表报道撤回即从热点主体和热度剔除，公开及机器出口不沿用旧快照来源名", async () => {
  const original = (await app.inject({ url: "/api/v1/hot-topics" })).json().items[0], before = calls;
  const removed = ids.find(id => id !== original.id)!;
  const removedName = `公开观察${ids.indexOf(removed)}`;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/content/${removed}/visibility`, headers,
    payload: { version: 0, visibility: "withdrawn", reason: "撤回一份普通公开报道" } })).statusCode, 200);
  const response = await app.inject({ url: "/api/site/hot" }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().entries.length, 1); assert.equal(response.json().entries[0].participantCount, 2, "撤回不能等下轮热度任务才生效");
  assert.ok(!response.body.includes(removedName));
  assert.ok(response.json().entries[0].heat <= 27.5 && response.json().entries[0].heat > 27, "热度只能包含两位当前有效主体");
  const api = await app.inject({ url: "/api/v1/hot-topics" }); assert.equal(api.json().items[0].participantCount, 2); assert.ok(!api.body.includes(removedName));
  await schedule("studio.news.hot.schedule")!.run(); assert.equal(calls, before);
});

test("来源即时改为私有后，旧榜单不再计算或展示该主体，不能等后台重发才隐藏", async () => {
  const original = (await app.inject({ url: "/api/v1/hot-topics" })).json().items[0], before = calls;
  const detail = (await app.inject({ url: `/api/site/stories/${original.links.story.split("/").at(-1)}` })).json();
  const remaining = ids.find(id => id !== original.id && detail.timeline.some((item: { id: string }) => item.id === id))!;
  const sourceId = `phase2-hot-${ids.indexOf(remaining)}`;
  const read = await app.inject({ url: `/api/admin/studio/news-sources?q=${sourceId}`, headers }); assert.equal(read.statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/sources/${sourceId}`, headers,
    payload: { version: read.json().rows[0].version, patch: { participation_mode: "isolated" } } })).statusCode, 200);
  const current = await app.inject({ url: "/api/site/hot" }); assert.equal(current.statusCode, 200);
  assert.equal(current.json().entries.length, 1, "仅剩一位公开主体仍按低热度可见，但不能沿用私有第二位主体");
  assert.equal(current.json().entries[0].participantCount, 1);
  assert.equal((await app.inject({ url: "/api/v1/hot-topics" })).json().items.length, 1);
  assert.equal(calls, before);
});

test("同机构多账号只计一个主体，24小时热度减半，超过48小时按衰减竞争仍可在榜且不调用模型", async t => {
  const before = calls;
  const rows = (await app.inject({ url: "/api/admin/studio/news-sources?q=phase2-hot", headers })).json().rows;
  for (const row of rows) assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/sources/${row.id}`, headers,
    payload: { version: row.version, patch: { participation_mode: "editorial", signal_group_id: row.id === "phase2-hot-2" ? null : "hot-same-operator" } } })).statusCode, 200);
  for (const id of ids) {
    const current = await app.inject({ url: `/api/site/items/${id}` });
    if (current.statusCode === 404) assert.equal((await app.inject({ method: "POST", url: `/api/admin/content/${id}/visibility`, headers,
      payload: { version: 1, visibility: "public", reason: "恢复以验证主体去重" } })).statusCode, 200);
  }
  await schedule("studio.news.hot.schedule")!.run();
  let response = (await app.inject({ url: "/api/site/hot" })).json();
  assert.equal(response.entries[0].participantCount, 2); assert.ok(response.entries[0].heat <= 27.5 && response.entries[0].heat > 27);
  const now = Date.now(); t.mock.timers.enable({ apis: ["Date"], now: now + 24 * 3600000 });
  await schedule("studio.news.heat.schedule")!.run();
  await schedule("studio.news.hot.schedule")!.run();
  response = (await app.inject({ url: "/api/site/hot" })).json();
  assert.equal(response.entries[0].participantCount, 2); assert.ok(response.entries[0].heat <= 15 && response.entries[0].heat > 14.5);
  assert.ok(response.entries[0].spark.filter((point: unknown) => point !== null).length <= 1, "只有当前一条实测记录时不能伪造历史曲线");
  t.mock.timers.setTime(now + 49 * 3600000);
  assert.equal((await app.inject({ url: "/api/site/hot" })).json().entries.length, 1, "公开资格有效的前十事件超过48h仍按衰减竞争");
  assert.equal(calls, before);
});

test("实际热点页面在桌面和窄屏展示公开事件与来源，没有数据时不造走势图", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { mkdir } = await import("node:fs/promises"); await mkdir(".impeccable/review", { recursive: true });
  transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const before = calls, web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage();
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(web.origin + "/hot"); assert.equal(response?.status(), 200);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("热点");
      await expect(page.getByRole("heading", { name: "AI影视热点榜", exact: true })).toBeVisible();
      await expect(page.getByText("按已观测传播热度持续更新，热度衰减与新事件共同决定排名", { exact: false }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "角色控制更新", exact: true }).first()).toBeVisible();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/phase2-hot-${width}.png`, fullPage: true });
      await page.getByRole("link", { name: "角色控制更新", exact: true }).first().click();
      await expect(page.locator('a[href^="/topics/"]')).toHaveCount(0);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    }
    assert.equal(calls, before);
  } finally { await browser.close(); await web.stop(); }
});


test("同5分热度档按新闻价值暂排，单源几分衰减差不冒充可靠的传播差距", async () => {
  const saved: string[]=[];
  for (const [suffix, age, body] of [["strong",8,"较强比对：AI视频新增角色控制与明确使用限制。"],["weak",4,"较弱比对：AI视频的影展讨论及观众反应。"]] as const) {
    saved.push((await upsertMaterial({sourceId:"phase2-hot-2",title:body,url:`https://phase2-hot-2.example/${suffix}`,via:"import",publishedAt:new Date(Date.now()-age*3600000),bodyText:body,bodyStatus:"ok"})).articleId);
  }
  await scheduleTopicMaterialAnalyses(); const boss=await getBoss();
  for (;;) {const [job]=await boss.fetch(topicAnalysisQueue.name);if(!job)break;await topicAnalysisQueue.run([job.data] as never[]);await boss.complete(topicAnalysisQueue.name,job.id);}
  await schedule("studio.news.publication.schedule")!.run();await schedule("studio.news.hot.schedule")!.run();
  const entries=(await app.inject({url:"/api/site/hot"})).json().entries;
  const strong=entries.find((entry:any)=>entry.story.title.includes("较强比对")), weak=entries.find((entry:any)=>entry.story.title.includes("较弱比对"));
  assert.ok(strong&&weak);assert.ok(strong.heat<weak.heat);assert.ok(strong.rank<weak.rank);assert.equal(strong.heatBasis,"single_source");
});
