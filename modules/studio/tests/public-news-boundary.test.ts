import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { getBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import type { LightMyRequestResponse } from "fastify";
import { composeDaily } from "@aihot/backend/reports/compose";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
let calls = 0;
let qualifiedId = "";
const coverUrl = "https://public-image.example/cover.png";
let coverEtag = "";
const mcpLatest = () => app.inject({ method: "POST", url: "/api/mcp", headers: { host: "localhost", "content-type": "application/json",
  accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": MCP_TOOL_NAMES.latest },
  payload: { jsonrpc: "2.0", id: "public-boundary", method: "tools/call", params: {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }, name: MCP_TOOL_NAMES.latest,
    arguments: { mode: "all", window: "7d", limit: 30 } } } });
transport.get("https://api.deepseek.com").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(request => {
  calls++; const input = JSON.parse(JSON.parse(String(request.body)).messages.at(-1).content), quote = input.material.body;
  return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    columnId: "models", disposition: "support", summary: "角色工具新增参考控制，尚未验证多人镜头。", reason: "工具能力与使用限制", viewerBenefit: "判断参考控制的使用边界", event: null,
    evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 90, practical: 90, evidence: 95, freshness: null, demand: null, distinctiveness: 80 },
    shared: { scope: "direct", editorialScope: "direct_ai_film", aiCentral: true, filmRelevant: true,
      scopeReason: "影响影视制作", scopeQuotes: [quote], facts: [{ text: quote, quotes: [quote] }],
      publicDimensions: { practical: { value: 95, reason: "可直接用于制作" }, interest: { value: 95, reason: "创作者关心" }, substance: { value: 95, reason: "明确能力与限制" } },
      impact: { value: 90, reason: "影响制作边界" },
      v2: { I: { value: 95, reason: "创作者关心" }, M: { value: 90, reason: "影响制作边界" }, D: { value: 95, reason: "明确能力与限制" },
        P: { value: 95, reason: "可直接用于制作" }, E: { value: 95, reason: "正文明确" }, X: { value: 80, reason: "参考控制新能力" } },
      publicSummary: "角色工具新增参考控制，尚未验证多人镜头。", summaryFactIds: [0], primaryIntent: "models", majorEvent: null,
      columnMatches: [{ columnId: "models", value: 90, reason: "工具能力" }], event: null, reportingKind: "original", memeEvidence: [] },
  }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) };
}).persist();
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("尚无二期发布许可的旧新闻，即使有旧编辑公开记录，也不经详情、搜索、订阅和分享泄露", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: {
    id: "private-legacy-news", name: "旧新闻来源", kind: "rss", config: { feedUrl: "https://legacy-news.example/feed" },
  } })).statusCode, 200);
  const material = await upsertMaterial({ sourceId: "private-legacy-news", title: "内部未审核影视消息", url: "https://legacy-news.example/old",
    via: "import", publishedAt: new Date(), bodyText: "PRIVATE-UNREVIEWED-CONTENT", bodyHtml: "<p>PRIVATE-UNREVIEWED-CONTENT</p>", bodyStatus: "ok" });
  const id = material.articleId;
  const override = await app.inject({ method: "POST", url: `/api/admin/content/${id}/override`, headers, payload: {
    version: 0, reason: "模拟一期保留的旧公开判断，不是二期发布许可", fields: { title: "内部未审核影视消息", summary: "PRIVATE-LEGACY-SUMMARY", score: 90, selected: true },
  } });
  assert.equal(override.statusCode, 200, override.body);
  for (const url of [`/api/site/items/${id}`, `/api/site/items/${id}/original`, `/items/${id}/markdown`, `/og/items/${id}.png`, `/og/posters/${id}.png`]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 404, url); assert.ok(!response.body.includes("PRIVATE-"));
  }
  for (const url of ["/api/site/pool", "/api/site/timeline", "/api/v1/items?mode=all", "/api/v1/selected/snapshot", "/feed.xml", "/feed/all.xml", "/feed/full.xml"]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 200, url); assert.ok(!response.body.includes("PRIVATE-"), url);
  }
  const availability = (await app.inject({ url: `/api/site/items/availability?ids=${id}` })).json();
  assert.equal(availability[id].status, "unavailable");
  const stats = (await app.inject({ url: "/api/site/stats" })).json();
  assert.equal(stats.items, 0); assert.equal(stats.sources, 0); assert.deepEqual(stats.sampleSources, []);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/news:${id}` })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/news:${id}`, headers })).statusCode, 200);
});

test("共享分析完成的合格新闻通过原发布层自动公开，公开发布与刷新不增加模型调用", async () => {
  config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {
    version: 0, baseUrl: "https://api.deepseek.com/v1", apiKey: "public-news-test-key", analysisModel: "deepseek-flash", qualityModel: "deepseek-flash",
  } })).statusCode, 200);
  const saved = await upsertMaterial({ sourceId: "private-legacy-news", title: "角色参考工具新增控制", url: "https://legacy-news.example/qualified",
    via: "import", publishedAt: new Date(), bodyText: "角色参考工具新增参考控制，尚未验证多人镜头。授权全文检索标记LICENSEONLYTOKEN。", bodyHtml: "<p>角色参考工具新增参考控制，尚未验证多人镜头。授权全文检索标记LICENSEONLYTOKEN。</p>", bodyStatus: "ok", media: [{ kind: "image", url: coverUrl }] });
  qualifiedId = saved.articleId;
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  const before = calls, schedule = serverModules().find(module => module.name === "studio")!.schedules!
    .find(item => item.name === "studio.news.publication.schedule");
  assert.ok(schedule, "共享处理必须连接实际后台发布流程"); await schedule.run();
  const response = await app.inject({ url: `/api/site/items/${saved.articleId}` }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().summary, "角色工具新增参考控制，尚未验证多人镜头。"); assert.equal(response.json().selected, true);
  assert.equal(response.json().body, null, "未获来源全文许可时只公开摘要");
  assert.ok((await app.inject({ url: "/api/v1/items?mode=all" })).body.includes(saved.articleId));
  assert.ok((await app.inject({ url: "/feed.xml" })).body.includes(saved.articleId));
  const mcp = await mcpLatest(); assert.equal(mcp.statusCode, 200, mcp.body); assert.ok(mcp.body.includes(saved.articleId), mcp.body);
  const { default: sharp } = await import("sharp"), png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).png().toBuffer();
  transport.get("https://public-image.example").intercept({ method: "GET", path: "/cover.png" }).reply(200, png, { headers: { "content-type": "image/png" } });
  await resources.warm();
  const cover = await app.inject({ url: proxiedImage(coverUrl, "thumb")! });
  assert.equal(cover.statusCode, 200, cover.body); assert.ok(String(cover.headers["content-type"]).startsWith("image/")); coverEtag = String(cover.headers.etag);
  await schedule.run(); await app.inject({ url: "/api/site/pool" });
  assert.equal(calls, before, "共享结果已准备好，发布/重算/读取都不调用模型");
});

test("来源撤销再分发或站内全文许可立即生效，不等待后台重建，也不购买新分析", async () => {
  const before = calls;
  async function permit(patch: { site_fulltext?: boolean; syndicate_fulltext?: boolean }) {
    const source = (await app.inject({ url: "/api/admin/sources/private-legacy-news", headers })).json().source;
    const saved = await app.inject({ method: "PATCH", url: "/api/admin/sources/private-legacy-news", headers,
      payload: { version: source.updated_at, patch } });
    assert.equal(saved.statusCode, 200, saved.body);
  }
  await permit({ site_fulltext: true, syndicate_fulltext: true });
  await serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === "studio.news.publication.schedule")!.run();
  const url = `/api/site/items/${qualifiedId}`, original = await app.inject({ url });
  assert.equal(original.statusCode, 200); assert.ok(original.json().body?.zh?.includes("角色参考工具新增参考控制"));
  const feed = await app.inject({ url: "/feed/full.xml" }); assert.ok(feed.body.includes("<content:encoded>"));
  const queries = ["LICENSEONLYTOKEN", "LICENSEONLYTOKEN 控制", "授权"];
  for (const query of queries) assert.ok((await app.inject({ url: `/api/site/pool?q=${encodeURIComponent(query)}&tab=relevance` })).body.includes(qualifiedId), query);
  await permit({ syndicate_fulltext: false });
  const revokedFeed = await app.inject({ url: "/feed/full.xml", headers: { "if-none-match": String(feed.headers.etag) } });
  assert.equal(revokedFeed.statusCode, 200); assert.ok(!revokedFeed.body.includes("<content:encoded>"));
  assert.ok((await app.inject({ url })).json().body, "只撤销再分发，不影响仍获授权的站内全文");
  await permit({ site_fulltext: false });
  const revoked = await app.inject({ url, headers: { "if-none-match": String(original.headers.etag) } });
  assert.equal(revoked.statusCode, 200); assert.equal(revoked.json().body, null);
  const markdown = await app.inject({ url: `/items/${qualifiedId}/markdown` });
  assert.equal(markdown.statusCode, 200); assert.ok(!markdown.body.includes("## 正文"));
  assert.equal((await app.inject({ url: `${url}/original` })).json().body, null);
  for (const query of queries) assert.ok(!(await app.inject({ url: `/api/site/pool?q=${encodeURIComponent(query)}&tab=relevance` })).body.includes(qualifiedId),
    `全文许可撤销后，旧全文索引也不能暴露匹配结果：${query}`);
  assert.equal(calls, before);
});

test("旧编排器保存的日报不借用新闻许可公开，独立正文、目录、分享和机器出口均拒绝", async () => {
  const before = calls, nextEdition = new Date(); nextEdition.setUTCHours(0, 0, 0, 0);
  if (nextEdition.getTime() <= Date.now()) nextEdition.setUTCDate(nextEdition.getUTCDate() + 1);
  const date = nextEdition.toISOString().slice(0, 10);
  const report = await composeDaily(date); assert.ok(report.entries > 0, "沿实际旧报告编排保存一份有正文的旧日报");
  for (const url of [`/api/site/reports/daily/${date}`, `/api/v1/dailies/${date}`, `/api/v1/agent/daily/${date}`, `/og/reports/daily/${date}.png`]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 404, url);
    assert.ok(!response.body.includes("角色工具新增参考控制"), url);
  }
  for (const url of ["/api/site/reports/daily", "/api/site/reports/daily/latest-page", `/api/site/reports/daily/months/${date.slice(0, 7)}`,
    "/api/v1/dailies", "/feed/daily.xml", "/sitemap.xml"]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 200, url);
    assert.ok(!response.body.includes(date), url);
  }
  assert.equal((await app.inject({ url: "/api/site/stats" })).json().dailies, 0);
  const discovery = await app.inject({ url: "/sitemap.xml" });
  assert.ok(!discovery.body.includes("/weekly")); assert.ok(!discovery.body.includes("/monthly"));
  assert.equal(calls, before, "公开许可核查与旧模板夹具不触发新模型调用");
});

test("公开内容的客户端与代理缓存必须回源检查当前许可，服务器仍复用准备好的图片字节", async () => {
  const before = calls;
  for (const url of [`/api/site/items/${qualifiedId}`, "/api/site/pool", "/api/site/timeline", "/api/site/stats", "/api/site/topics",
    "/api/v1/items?mode=all", "/api/v1/selected/snapshot", "/feed.xml", "/feed/full.xml", "/sitemap.xml", proxiedImage(coverUrl, "thumb")!]) {
    const response = await app.inject({ url }); assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["cache-control"], "no-store", url);
    assert.equal(response.headers["x-accel-expires"], "0", url);
  }
  assert.equal(calls, before);
});

test("正文更正立即撤销旧发布许可，未完成新分析不复用旧结论公开；撤回覆盖旧ETag与后台重建", async () => {
  const url = `/api/site/items/${qualifiedId}`, before = calls;
  await upsertMaterial({ sourceId: "private-legacy-news", title: "角色参考工具新增控制", url: "https://legacy-news.example/qualified",
    via: "import", bodyText: "更正：角色参考控制仅支持固定机位，不支持运动镜头。", bodyStatus: "ok" });
  assert.equal((await app.inject({ url })).statusCode, 404);
  const schedule = serverModules().find(module => module.name === "studio")!.schedules!.find(item => item.name === "studio.news.publication.schedule")!;
  await schedule.run(); assert.equal((await app.inject({ url })).statusCode, 404);
  assert.ok(!(await app.inject({ url: "/feed.xml" })).body.includes(qualifiedId)); assert.equal(calls, before);
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss();
  for (;;) { const [job] = await boss.fetch(topicAnalysisQueue.name); if (!job) break; await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  await schedule.run(); const current = await app.inject({ url }); assert.equal(current.statusCode, 200, current.body);
  const withdrawn = await app.inject({ method: "POST", url: `/api/admin/content/${qualifiedId}/visibility`, headers,
    payload: { version: 0, visibility: "withdrawn", reason: "来源申请下架" } });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal((await app.inject({ url, headers: { "if-none-match": String(current.headers.etag) } })).statusCode, 404);
  await schedule.run(); assert.equal((await app.inject({ url })).statusCode, 404);
  assert.ok(!(await app.inject({ url: "/api/v1/selected/snapshot" })).body.includes(qualifiedId));
  const mcp = await mcpLatest(); assert.equal(mcp.statusCode, 200, mcp.body); assert.ok(!mcp.body.includes(qualifiedId), "MCP不得从独立答案缓存返回已撤回内容");
  assert.ok(!(await app.inject({ url: "/sitemap.xml" })).body.includes(`/items/${qualifiedId}`));
  assert.ok(!(await app.inject({ url: "/api/site/stats" })).body.includes(qualifiedId));
  assert.equal((await app.inject({ url: proxiedImage(coverUrl, "thumb")!, headers: { "if-none-match": coverEtag } })).statusCode, 403,
    "撤回后不能从已准备的图片字节或旧ETag绕过许可");
  assert.equal(calls, before + 1, "只为更正后的新正文执行一次原分析");
});

test("有效图片签名本身不能授权未公开材料或无归属图片，即使带旧缓存验证器也必须拒绝", async () => {
  const signed = proxiedImage("https://private-image.example/unapproved.png", "thumb"); assert.ok(signed);
  const variations: Array<Record<string, string>> = [{}, { "if-none-match": '"old-private-image"' }];
  for (const requestHeaders of variations) {
    const response: LightMyRequestResponse = await app.inject({ url: signed, headers: requestHeaders });
    assert.equal(response.statusCode, 403); assert.equal(response.headers["cache-control"], "no-store");
  }
});
