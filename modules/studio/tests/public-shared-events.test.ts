import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import type { TimelineResponse, SiteItemDetail } from "@aihot/contracts/site";
import { beijingDate, addDays } from "@aihot/contracts/time";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
let calls = 0;
let rootStoryId = "", rootIds: string[] = [], rootAnchor = "";
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++;
  const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content), quote = input.material.body;
  const development = String(quote).includes("运动镜头"), candidate = input.eventCandidates[0]?.id ?? null;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: quote, reason: "参考控制能力与边界", viewerBenefit: "判断角色制作流程", event: null,
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 95, practical: 95, evidence: 95, freshness: null, demand: null, distinctiveness: 90 },
    shared: { scope: "direct", editorialScope: "direct_ai_film", aiCentral: true, filmRelevant: true,
      scopeReason: "影视工具能力", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: 95, reason: "能用于影视制作" }, interest: { value: 95, reason: "受众关注" }, substance: { value: 95, reason: "有明确变化" } },
      impact: { value: 90, reason: "影响角色制作" },
      v2: { I: { value: 95, reason: "受众关注" }, M: { value: 90, reason: "影响角色制作" }, D: { value: 95, reason: "有明确变化" },
        P: { value: 95, reason: "能用于影视制作" }, E: { value: 95, reason: "正文明确" }, X: { value: 90, reason: "新增运动镜头支持" } },
      publicSummary: quote, summaryFactIds: [0], primaryIntent: "models", majorEvent: null,
      columnMatches: [{ columnId: "models", value: 95, reason: "制作工具" }], reportingKind: development ? "development" : "original", memeEvidence: [],
      event: { relation: development ? "development" : "new", candidateId: development ? candidate : null,
        label: development ? "角色工具新增运动镜头支持" : "角色工具参考控制发布", identity: development ? "角色工具运动支持" : "角色工具参考发布", quotes: [quote] } },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

async function processNews() {
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await serverModules().find(module => module.name === "studio")!.schedules!.find(schedule => schedule.name === "studio.news.publication.schedule")!.run();
}

test("共享事件中的重复报道复用分析并在公开精选归为一组，展开能看到全部公开来源", async () => {
  config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "shared-public-test", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  for (const source of ["public-shared-one", "public-shared-two"]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
      id: source, name: source, kind: "rss", config: { feedUrl: `https://${source}.example/feed` },
    } })).statusCode, 200);
    await upsertMaterial({ sourceId: source, title: "角色工具参考控制发布", url: `https://${source}.example/release`,
      publishedAt: new Date(), via: "import", bodyText: "角色工具参考控制发布，可复用固定人物设定；目前只支持固定机位。", bodyStatus: "ok" });
    await processNews();
  }
  const timeline = (await app.inject({ url: "/api/site/timeline" })).json<TimelineResponse>();
  assert.equal(timeline.cards.length, 1, "同一事件不能因为两个出处显示两张独立卡片");
  assert.equal(timeline.cards[0]!.group?.reportCount, 2); assert.equal(timeline.cards[0]!.group?.additionalSourceCount, 1);
  const pool = (await app.inject({ url: "/api/site/pool" })).json();
  assert.equal(pool.items.length, 1, "全部动态也按同一事件收拢，不能只在精选去重");
  assert.equal(pool.total, 1); assert.equal(pool.items[0].group.reportCount, 2);
  const reports = await app.inject({ url: `/api/site/groups/${timeline.cards[0]!.group!.factId}/reports` });
  assert.equal(reports.statusCode, 200); assert.equal(reports.json().reports.length, 2);
  rootIds = reports.json().reports.map((report: { id: string }) => report.id); rootAnchor = timeline.cards[0]!.anchorAt;
  assert.equal(calls, 1, "相同正文复用分析，公开归并不另买分组判断");
  const detail = (await app.inject({ url: `/api/site/items/${timeline.cards[0]!.item.id}` })).json<SiteItemDetail>();
  assert.ok(detail.story?.publicId); rootStoryId = detail.story.publicId;
  assert.equal((await app.inject({ url: `/api/site/stories/${rootStoryId}` })).statusCode, 200);
});

test("四栏目筛选可读共享分类，全部滚动120小时而精选48小时，旧稳定链接和内部材料仍可读", async t => {
  const pool = await app.inject({ url: "/api/site/pool?category=models" });
  assert.equal(pool.statusCode, 200, pool.body); assert.ok(pool.json().items.length > 0);
  const id = pool.json().items[0].id, before = calls;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 49 * 3600000 });
  assert.ok((await app.inject({ url: "/api/site/pool?category=models" })).json().items.length > 0, "全部动态保持120小时");
  assert.equal((await app.inject({ url: "/api/site/timeline" })).json().cards.length, 0, "精选时间轴回到48小时");
  t.mock.timers.setTime(Date.now() + 72 * 3600000);
  await serverModules().find(module => module.name === "studio")!.schedules!.find(schedule => schedule.name === "studio.news.publication.schedule")!.run();
  assert.equal((await app.inject({ url: "/api/site/pool?category=models" })).json().items.length, 0);
  assert.equal((await app.inject({ url: `/api/site/items/${id}` })).statusCode, 200, "超出列表窗口不是下架");
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/news:${id}`, headers })).statusCode, 200);
  assert.equal(calls, before);
});

test("实质进展成为同一故事下的新事实，不把旧事件重新计时；撤回旧报道后不继续展示其标题", async () => {
  const material = await upsertMaterial({ sourceId: "public-shared-one", title: "角色工具运动镜头能力进展", url: "https://public-shared-one.example/motion",
    publishedAt: new Date(), via: "import", bodyText: "角色工具参考控制现已支持运动镜头，但仍限两个人物。", bodyStatus: "ok" });
  await processNews();
  const timeline = (await app.inject({ url: "/api/site/timeline" })).json<TimelineResponse>();
  assert.equal(timeline.cards.length, 2); assert.equal(timeline.cards.find(card => card.group?.reportCount === 2)?.anchorAt, rootAnchor);
  const detail = (await app.inject({ url: `/api/site/items/${material.articleId}` })).json<SiteItemDetail>();
  assert.equal(detail.story?.publicId, rootStoryId);
  const story = (await app.inject({ url: `/api/site/stories/${rootStoryId}` })).json();
  assert.equal(story.developments.length, 2); assert.equal(story.reportCount, 3); assert.equal(calls, 2);
  for (const id of rootIds) {
    const response = await app.inject({ method: "POST", url: `/api/admin/content/${id}/visibility`, headers,
      payload: { version: 0, visibility: "withdrawn", reason: "旧报道已更正并申请下架" } });
    assert.equal(response.statusCode, 200, response.body);
  }
  const current = await app.inject({ url: `/api/site/stories/${rootStoryId}` }); assert.equal(current.statusCode, 200);
  assert.equal(current.json().reportCount, 1); assert.equal(current.json().title, "角色工具运动镜头能力进展");
  assert.ok(!current.body.includes("角色工具参考控制发布"), "已撤回材料不能借旧故事标题或事实标题继续展示");
  assert.equal(calls, 2);
});

test("公开日期筛选按香港日历且受48小时窗口约束，列表和精选计数使用同一日期", async () => {
  const today = beijingDate(new Date()), yesterday = addDays(today, -1), before = calls;
  for (const path of ["pool", "timeline"]) {
    const current = await app.inject({ url: `/api/site/${path}?day=${today}` }); assert.equal(current.statusCode, 200);
    assert.equal(current.json()[path === "pool" ? "items" : "cards"].length, 1);
    const previous = await app.inject({ url: `/api/site/${path}?day=${yesterday}` }); assert.equal(previous.statusCode, 200);
    assert.equal(previous.json()[path === "pool" ? "items" : "cards"].length, 0);
    assert.equal((await app.inject({ url: `/api/site/${path}?day=2026-02-30` })).statusCode, 400);
  }
  assert.equal(calls, before);
});

test("真实网页四栏目、无分类精选、日期切换和内部长时间轴在桌面与窄屏可用", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { mkdir } = await import("node:fs/promises"); await mkdir(".impeccable/review", { recursive: true });
  const before = calls;
  for (let index = 0; index < 32; index++) await upsertMaterial({ sourceId: "public-shared-one", title: `内部布局验收 ${index} · ${"角色制作流程与实用限制".repeat(7)}`,
    url: `https://public-shared-one.example/layout-${index}`, via: "import", publishedAt: new Date(), bodyText: "内部未分析材料，不能自动公开。", bodyStatus: "ok" });
  transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const separator = headers.cookie.indexOf("=");
    await page.context().addCookies([{ name: headers.cookie.slice(0, separator), value: headers.cookie.slice(separator + 1), url: web.origin }]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/all", "/admin/studio/intelligence"]) {
        const response = await page.goto(web.origin + path); assert.equal(response?.status(), 200, path);
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, `${width} ${path}`);
        if (path === "/") { await expect(page.getByRole("link", { name: "实操与提效", exact: true })).toHaveCount(0); }
        if (path === "/all") {
          await expect(page.getByLabel("按日期查看新闻")).toBeVisible();
          if (width === 1440) {
            await page.getByLabel("筛选", { exact: true }).getByRole("link", { name: "模型与工具", exact: true }).click(); await expect(page).toHaveURL(/category=models/);
            await page.getByLabel("按日期查看新闻").fill(beijingDate(new Date())); await expect(page).toHaveURL(/day=/);
          }
        }
        if (path.includes("intelligence")) {
          await expect(page.getByText("今天收录的全部新闻、博主内容和热榜材料，按香港时间排列。")).toBeVisible();
          assert.ok(["auto","visible"].includes(await page.evaluate("getComputedStyle(document.querySelector('.studio-page-content')).overflowY")));
          assert.ok(await page.evaluate("document.documentElement.scrollHeight > innerHeight || document.querySelector('.studio-page-content').scrollHeight > document.querySelector('.studio-page-content').clientHeight"), "动态保留可滚动内容，分页可继续访问");
          assert.equal(await page.getByRole("list", { name: "情报动态" }).locator("li").count(), 30);
          await page.getByRole("link", { name: "下一页", exact: true }).click(); await expect(page).toHaveURL(/page=2/);
          assert.ok(await page.getByRole("list", { name: "情报动态" }).locator("li").count() > 0);
        }
        await page.screenshot({ path: `.impeccable/review/phase2-feed-${path === "/" ? "home" : path.includes("intelligence") ? "private" : "all"}-${width}.png`, fullPage: true });
      }
    }
    await page.goto(web.origin + "/more"); await expect(page.getByRole("link", { name: "工作台登录", exact: true })).toBeVisible();
    assert.equal(calls, before, "页面和分页不启动材料分析");
  } finally { await browser.close(); await web.stop(); }
});

test("数字门槛经有界后台刷新重排公开去向，不买分析；手动拆分不会被共享投影重新归并", async () => {
  const before = calls, policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  const id = (await app.inject({ url: "/api/site/pool" })).json().items[0].id;
  const changed = await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
    payload: { ...policy, editorial: { ...policy.editorial, public: { ...policy.editorial.public,
      selected: { ...policy.editorial.public.selected, S: 100 } } } } });
  assert.equal(changed.statusCode, 200, changed.body);
  const publish = serverModules().find(module => module.name === "studio")!.schedules!.find(schedule => schedule.name === "studio.news.publication.schedule")!;
  for (let turn = 0; turn < 3; turn++) await publish.run();
  assert.equal((await app.inject({ url: `/api/site/items/${id}` })).json().selected, false);
  assert.equal((await app.inject({ url: "/api/site/timeline" })).json().cards.length, 0);
  assert.ok((await app.inject({ url: "/api/site/pool" })).body.includes(id), "不够精选仍可在全部动态阅读");
  const restored = await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
    payload: { ...policy, version: changed.json().policy.version } }); assert.equal(restored.statusCode, 200, restored.body);
  for (let turn = 0; turn < 3; turn++) await publish.run();
  assert.equal((await app.inject({ url: `/api/site/items/${id}` })).json().selected, true);
  const detached = await app.inject({ method: "POST", url: `/api/admin/content/${id}/detach`, headers, payload: { reason: "管理员要求独立展示" } });
  assert.equal(detached.statusCode, 200, detached.body);
  for (let turn = 0; turn < 3; turn++) await publish.run();
  assert.equal((await app.inject({ url: `/api/site/items/${id}` })).json().story, null);
  assert.equal(calls, before);
});

test("未入精选的旧事件新增普通转载仍保留首现日期，超过120小时不重新上浮", async t => {
  const policy = (await app.inject({ url: "/api/admin/studio/filter-settings", headers })).json().policy;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/filter-settings", headers,
    payload: { ...policy, editorial: { ...policy.editorial, public: { ...policy.editorial.public,
      selected: { ...policy.editorial.public.selected, S: 100 } } } } })).statusCode, 200);
  const publish = serverModules().find(module => module.name === "studio")!.schedules!.find(schedule => schedule.name === "studio.news.publication.schedule")!;
  for (let turn = 0; turn < 3; turn++) await publish.run();
  assert.equal((await app.inject({ url: `/api/site/items/${rootIds[0]}` })).statusCode, 404, "先完成已撤回原报道的后台重建");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 121 * 3600000 });
  const material = await upsertMaterial({ sourceId: "public-shared-two", title: "角色工具参考控制发布", url: "https://public-shared-two.example/reprint",
    publishedAt: new Date(), via: "import", bodyText: "角色工具参考控制发布，可复用固定人物设定；目前只支持固定机位。", bodyStatus: "ok" });
  await processNews();
  assert.equal((await app.inject({ url: `/api/site/items/${material.articleId}` })).statusCode, 200, "旧事件稳定链接仍可阅读");
  assert.equal((await app.inject({ url: "/api/site/pool" })).json().items.length, 0, "普通转载不能把超过5天的旧事实包装成新事件");
  assert.equal((await app.inject({ url: `/api/site/pool?day=${beijingDate(new Date())}` })).json().total, 0);
});
