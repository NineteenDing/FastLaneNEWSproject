import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
let calls = 0;
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++;
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content), quote = input.material.body;
  const day = quote.match(/2026年10月(\d+)日10:00/)?.[1];
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: "镜头控制更新与公开限制", reason: "制作工具更新", viewerBenefit: "评估镜头工作流", event: "镜头V4更新",
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 85, practical: 70, evidence: 80, freshness: 99, demand: null, distinctiveness: 60 },
    shared: { scope: "direct", editorialScope: "direct_ai_film", aiCentral: true, filmRelevant: true,
      scopeReason: "直接影响影视制作", scopeQuotes: [quote], facts: [{ text: "新增镜头控制", quotes: [quote] }],
      publicDimensions: { practical: { value: 80, reason: "工作流明确" }, interest: { value: 60, reason: "创作者关心" }, substance: { value: 75, reason: "公开能力与条件" } },
      impact: { value: 90, reason: "改变连续镜头制作能力" }, columnMatches: [{ columnId: "models", value: 95, reason: "更新工具能力" }],
      v2: { I: { value: 60, reason: "创作者关心" }, M: { value: 90, reason: "改变连续镜头制作能力" },
        D: { value: 75, reason: "公开能力与条件" }, P: { value: 80, reason: "工作流明确" },
        E: { value: 80, reason: "原文已明确" }, X: { value: 60, reason: "新增镜头控制角度" } },
      publicSummary: "2026年10月24日，镜头V4发布连续镜头控制，暂不支持多人场景。", summaryFactIds: [0],
      primaryIntent: "models", majorEvent: null,
      event: { relation: "new", candidateId: null, label: input.material.title, identity: input.material.title, quotes: [quote],
        time: day ? { at: `2026-10-${day}T10:00:00+08:00`, precision: "instant", quote: `2026年10月${day}日10:00` } : null },
      reportingKind: "original", memeEvidence: [] },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
async function drain() { const boss = await getBoss(); for (;;) {
  const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) return;
  await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
} }

test("当前新闻双评分使用共享语义与本地热度时效，改数字立即重算但不重复理解正文", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T04:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "filter-score-test-key", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "filter-score-source", name: "评分测试来源", kind: "rss", config: { feedUrl: "https://score.example/feed" },
  } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "filter-score-source", title: "镜头V4正式更新", url: "https://score.example/v4", via: "import",
    publishedAt: new Date("2026-10-24T03:00:00Z"), discoveredAt: new Date("2026-10-24T03:30:00Z"),
    bodyText: "2026年10月24日10:00，镜头V4发布连续镜头控制，暂不支持多人场景。", bodyStatus: "ok" });
  const url = `/api/admin/studio/intelligence/news:${saved.articleId}/scoring`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await scheduleTopicMaterialAnalyses()).queued, 1); await drain(); assert.equal(calls, 1);
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200, response.body);
  const score = response.json();
  assert.equal(score.policyVersion, 2); assert.equal(score.public.destination, "selected_candidate"); assert.equal(score.route, "direct_selected");
  assert.equal(score.public.contributions.practical, 8); assert.equal(score.public.contributions.interest, 15);
  assert.equal(score.public.contributions.impact, 22.5); assert.equal(score.public.contributions.substance, 11.25);
  assert.equal(score.public.contributions.freshness, 5); assert.equal(score.public.contributions.heat, 8);
  assert.equal(score.public.total, 69.75, "2小时的事件，1小时前发布的1个独立主体，连续锚点与24小时衰减");
  assert.equal(score.heatState, "partial"); assert.ok(score.heatFresh > 14 && score.heatFresh < 15);
  assert.equal(score.internal.contributions.impact, 18); assert.equal(score.internal.contributions.practical, 4);
  assert.equal(score.internal.contributions.evidence, 12); assert.equal(score.internal.total, 68);
  assert.equal(score.freshness.at, "2026-10-24T02:00:00.000Z"); assert.equal(score.freshness.basis, "event_evidence");
  assert.equal(score.columnMatches[0].publicColumn, "models"); assert.equal(calls, 1);
  const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers, payload: { ...policy,
    editorial: { ...policy.editorial, public: { ...policy.editorial.public,
      selected:{...policy.editorial.public.selected,S:68}, weights: { ...policy.editorial.public.weights, practical: 0, heat: 30 } } } } })).statusCode, 200);
  const changed = (await app.inject({ url, headers })).json();
  assert.equal(changed.policyVersion, 3); assert.equal(changed.public.total, 65.75); assert.equal(changed.public.destination, "all_candidate");
  assert.equal(calls, 1); assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
});

test("最近48小时试算展示新旧分数与精选去向，严格大于门槛，试算不保存也不调用模型", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T04:00:00Z") });
  const url = "/api/admin/studio/filter-settings/preview";
  const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  const proposed = { ...policy, editorial: { ...policy.editorial, public: { ...policy.editorial.public,
    weights: { ...policy.editorial.public.weights, practical: 10, heat: 20 } } } };
  const beforeCalls = calls;
  assert.equal((await app.inject({ method: "POST", url, payload: { policy: proposed } })).statusCode, 401);
  const response = await app.inject({ method: "POST", url, headers, payload: { policy: proposed } });
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json(); assert.equal(preview.total, 1); assert.equal(preview.rows.length, 1);
  assert.equal(preview.startsAt, "2026-10-19T04:00:00.000Z");
  assert.equal(preview.rows[0].before.public.total, 65.75); assert.equal(preview.rows[0].after.public.total, 69.75);
  assert.equal(preview.rows[0].before.public.destination, "all_candidate"); assert.equal(preview.rows[0].after.public.destination, "selected_candidate");
  assert.equal(preview.changedCount, 1); assert.equal(preview.rows[0].beforeRank, 1); assert.equal(preview.rows[0].afterRank, 1);
  const stricter = await app.inject({ method: "POST", url, headers, payload: { policy: { ...proposed, editorial: { ...proposed.editorial,
    public: { ...proposed.editorial.public, selected: { ...proposed.editorial.public.selected, S: 69.76 } } } } } });
  assert.equal(stricter.json().rows[0].after.public.destination, "all_candidate", "总分低于v2精选门槛时不精选");
  assert.equal((await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy.editorial.public.weights.practical, 0);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { policy: { ...proposed, version: 1 } } })).statusCode, 409);
  assert.equal(calls, beforeCalls);
});

test("旧事件今天转载不刷新事件时效，未知时间不借采集日期补分，48小时试算仍展示当前转载", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T04:00:00Z") }); await resources.warm();
  const before = calls;
  const repost = await upsertMaterial({ sourceId: "filter-score-source", title: "镜头V4正式更新", url: "https://score.example/repost-v4", via: "import",
    publishedAt: new Date("2026-10-27T03:00:00Z"), discoveredAt: new Date("2026-10-27T03:30:00Z"),
    bodyText: "2026年10月24日10:00，镜头V4发布连续镜头控制，暂不支持多人场景。", bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); await drain(); assert.equal(calls, before, "相同正文的转载复用原分析");
  const score = (await app.inject({ url: `/api/admin/studio/intelligence/news:${repost.articleId}/scoring`, headers })).json();
  assert.equal(score.freshness.at, "2026-10-24T02:00:00.000Z"); assert.equal(score.public.contributions.freshness, 2.21);
  assert.equal(score.internal.contributions.freshness, 2.21);
  const unknown = await upsertMaterial({ sourceId: "filter-score-source", title: "镜头V5控制公告", url: "https://score.example/v5-undated", via: "import",
    discoveredAt: new Date("2026-10-27T03:30:00Z"), bodyText: "未标时间，镜头V5新增镜头控制，尚未说明开放条件。", bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); await drain(); assert.equal(calls, before + 1);
  const undated = (await app.inject({ url: `/api/admin/studio/intelligence/news:${unknown.articleId}/scoring`, headers })).json();
  assert.equal(undated.freshness.basis, "unknown"); assert.equal(undated.public.values.freshness, 40);
  assert.equal(undated.public.contributions.freshness, 2, "时间未知使用明示的40分决策值并只贡献2分");
  const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  const preview = (await app.inject({ method: "POST", url: "/api/admin/studio/filter-settings/preview", headers, payload: { policy } })).json();
  assert.equal(preview.total, 3); assert.ok(preview.rows.some((row: { materialId: string }) => row.materialId === "news:" + repost.articleId));
  assert.equal(preview.changedCount, 0, "完全相同规则试算不因JSON字段顺序而误报变化");
  assert.equal(calls, before + 1);
});

test("原报道更正事件时间后当前分数跟随有效证据，不能永远沿用事件首次缓存的日期", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T04:00:00Z") }); await resources.warm();
  const before = calls;
  const corrected = await upsertMaterial({ sourceId: "filter-score-source", title: "镜头V4正式更新", url: "https://score.example/v4", via: "import",
    bodyText: "更正：2026年10月27日10:00，镜头V4发布连续镜头控制，暂不支持多人场景。", bodyStatus: "ok" });
  assert.equal(corrected.revised, true); await scheduleTopicMaterialAnalyses(); await drain(); assert.equal(calls, before + 1);
  const records = (await app.inject({ url: "/api/admin/studio/history?q=镜头V4", headers })).json().rows;
  const repost = records.find((row: { url: string }) => row.url.endsWith("repost-v4"));
  const result = (await app.inject({ url: `/api/admin/studio/intelligence/${repost.id}/scoring`, headers })).json();
  assert.equal(result.freshness.at, "2026-10-27T02:00:00.000Z"); assert.equal(result.public.contributions.freshness, 5);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "conflicting-date-source", name: "另一原始报道", kind: "rss", config: { feedUrl: "https://conflict.example/feed" },
  } })).statusCode, 200);
  await upsertMaterial({ sourceId: "conflicting-date-source", title: "镜头V4正式更新", url: "https://conflict.example/v4", via: "import",
    publishedAt: new Date("2026-10-27T03:00:00Z"), discoveredAt: new Date("2026-10-27T03:30:00Z"),
    bodyText: "独立原始报道：2026年10月26日10:00，镜头V4发布连续镜头控制，暂不支持多人场景。", bodyStatus: "ok" });
  await scheduleTopicMaterialAnalyses(); await drain(); assert.equal(calls, before + 2);
  const conflict = (await app.inject({ url: `/api/admin/studio/intelligence/${repost.id}/scoring`, headers })).json();
  assert.equal(conflict.freshness.basis, "unknown"); assert.equal(conflict.public.values.freshness, 40);
  assert.equal(conflict.public.contributions.freshness, 2, "原始报道日期冲突不回退成旧转载的日期");
});

test("网页修改后须先试算再保存，切换设置保留输入，桌面和手机长标题不溢出", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T04:00:00Z") });
  await upsertMaterial({ sourceId: "filter-score-source", title: "模型更新对AI影视创作者的工作流、成本与连续镜头制作有什么实际影响".repeat(4), url: "https://score.example/long-title",
    via: "import", discoveredAt: new Date("2026-10-27T03:30:00Z"), bodyText: "用于检验长标题换行的已有正文，不启动模型分析。", bodyStatus: "ok" });
  const { chromium, expect } = await import("@playwright/test"), { createServer, request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { listenHttpForFetch } = await import("../../../tests/http-listener.ts");
  const { inSettingsSection } = await import("./settings-navigation.ts");
  const origin = await listenHttpForFetch(app.server), api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", origin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(), beforeCalls = calls;
  try {
    await page.goto(web.origin + "/admin/studio/settings/filters"); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "内容筛选", exact: true }), publicPanel = panel.locator("section").filter({ has: page.getByRole("heading", { name: "公开新闻 · editorial-v2", exact: true }) });
    await expect(panel.getByRole("button", { name: "保存这版规则", exact: true })).toBeDisabled();
    await publicPanel.getByLabel("可操作价值权重", { exact: true }).fill("15");
    await expect(panel.getByRole("button", { name: "试算最近120小时", exact: true })).toBeDisabled();
    await publicPanel.getByLabel("传播热度权重", { exact: true }).fill("15");
    await inSettingsSection(page, "models", () => page.getByLabel("API Key", { exact: true }).fill("unsaved-filter-page-key"));
    await expect(publicPanel.getByLabel("可操作价值权重", { exact: true })).toHaveValue("15");
    await panel.getByRole("button", { name: "试算最近120小时", exact: true }).click();
    await expect(panel.getByRole("region", { name: "规则试算结果", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "保存这版规则", exact: true })).toBeEnabled();
    await expect(panel).toContainText("条材料");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await panel.screenshot({ path: `.impeccable/review/phase2-filter-settings-${width}.png` });
      await panel.getByRole("region", { name: "规则试算结果", exact: true }).screenshot({ path: `.impeccable/review/phase2-filter-trial-${width}.png` });
    }
    await panel.getByRole("button", { name: "保存这版规则", exact: true }).click(); await expect(panel).toContainText("已保存版本4");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("unsaved-filter-page-key");
    const saved = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
    assert.equal(saved.version, 4); assert.equal(saved.editorial.public.weights.practical, 15); assert.equal(calls, beforeCalls);
  } finally { await browser.close(); await web.stop(); }
});

