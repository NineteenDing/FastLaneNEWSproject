import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";

installModules(SERVER_MODULES);
const app = await buildApp(), previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
let sessionHeaders: { cookie: string; "x-csrf-token": string } | undefined;
async function auth() {
  if (sessionHeaders) return sessionHeaders;
  config.adminPassword = "intelligence-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ username: config.adminUsername ?? "admin", password: "intelligence-test-password" }).toString() });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } }); assert.equal(me.statusCode, 200);
  sessionHeaders = { cookie, "x-csrf-token": me.json().csrf }; return sessionHeaders;
}

test("私有情报动态统一读取已收录新闻和博主作品，按收录倒序且不受公开精选筛选影响", async () => {
  const headers = await auth();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "intelligence-news", name: "创作工具新闻", kind: "rss", config: { feedUrl: "https://news.example/rss?token=private-source-credential" } } })).statusCode, 200);
  const news = await upsertMaterial({ sourceId: "intelligence-news", title: "AI视频工具更新", url: "https://news.example/update", via: "import",
    discoveredAt: new Date(Date.now() - 3600_000), publishedAt: new Date("2026-10-17T10:00:00Z"),
    excerpt: "支持角色参考与镜头衔接", bodyText: "原文说明角色参考的使用条件。", bodyStatus: "ok" });
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(created.statusCode, 200); const creatorId = created.json().creator.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence" })).statusCode, 401);
  const response = await app.inject({ url: "/api/admin/studio/intelligence", headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const result = response.json(); assert.equal(result.total, 2); assert.equal(result.hasMore, false);
  assert.equal(result.rows[0].kind, "video"); assert.equal(result.rows[0].source.name, "影视流程研究");
  assert.equal(result.rows[0].source.platform, "bilibili"); assert.equal(result.rows[0].metrics.views, 12000);
  assert.equal(result.rows[1].id, "news:" + news.articleId); assert.equal(result.rows[1].title, "AI视频工具更新");
  assert.equal(result.rows[1].source.name, "创作工具新闻"); assert.equal(result.rows[1].excerpt, "支持角色参考与镜头衔接");
  assert.equal(result.rows[1].metrics, null); assert.equal(result.rows[1].publishedAt, "2026-10-17T10:00:00.000Z");
  assert.notEqual(result.rows[1].collectedAt, result.rows[1].publishedAt);
  assert.equal(result.rows[1].analysisState, "pending");
  assert.ok(!response.body.includes("private-source-credential")); assert.ok(!response.body.includes("body_text"));
  transport.assertNoPendingInterceptors();
});

test("情报详情返回新闻正文或视频简介与实际评论热度，未完成分析和转写不造结果", async () => {
  const headers = await auth();
  const rows = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows;
  const video = rows.find((row: { kind: string }) => row.kind === "video"), news = rows.find((row: { kind: string }) => row.kind === "news");
  const read = async (id: string) => app.inject({ url: `/api/admin/studio/intelligence/${encodeURIComponent(id)}`, headers });
  const article = await read(news.id); assert.equal(article.statusCode, 200);
  assert.equal(article.headers["cache-control"], "no-store");
  assert.equal(article.json().body, "原文说明角色参考的使用条件。"); assert.equal(article.json().bodyState, "ok");
  assert.equal(article.json().url, "https://news.example/update"); assert.deepEqual(article.json().observations, []);
  const content = await read(video.id); assert.equal(content.statusCode, 200);
  assert.equal(content.json().body, "先锁定参考，再组织镜头"); assert.equal(content.json().bodyState, "not_transcribed");
  assert.equal(content.json().comments[0].text, "换镜头后怎么维持角色？");
  assert.equal(content.json().observations[0].metrics.views, 12000); assert.equal(content.json().commentCoverage.complete, false);
  assert.equal(content.json().analysisState, "pending");
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${encodeURIComponent(video.id)}` })).statusCode, 401);
  assert.equal((await read("news:missing-news")).statusCode, 404);
  assert.equal((await read("creator:00000000-0000-0000-0000-000000000000")).statusCode, 404);
  assert.equal((await read("anything:other")).statusCode, 400);
  assert.ok(!content.body.includes("next_cursor")); assert.ok(!article.body.includes("private-source-credential"));
  transport.assertNoPendingInterceptors();
});

test("情报筛选组合全文关键词、内容类型与平台，分页保留范围且搜索通配符按文字处理", async () => {
  const headers = await auth();
  const read = async (query: string) => app.inject({ url: "/api/admin/studio/intelligence?" + query, headers });
  const video = await read("kind=video&platform=bilibili&limit=1"); assert.equal(video.statusCode, 200);
  assert.equal(video.json().total, 1); assert.equal(video.json().rows[0].title, "角色一致性的方法");
  const text = await read("q=" + encodeURIComponent("使用条件"));
  assert.equal(text.statusCode, 200); assert.equal(text.json().total, 1); assert.equal(text.json().rows[0].kind, "news");
  assert.equal((await read("q=" + encodeURIComponent("创作工具新闻"))).json().total, 1);
  assert.equal((await read("platform=news&kind=video")).json().total, 0);
  assert.equal((await read("q=%25")).json().total, 0);
  const first = (await read("limit=1")).json(), second = (await read("limit=1&page=2")).json();
  assert.equal(first.total, 2); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.notEqual(first.rows[0].id, second.rows[0].id);
  for (const query of ["kind=unknown", "platform=unknown", "page=0", "limit=101"]) assert.equal((await read(query)).statusCode, 400);
});

test("近24小时实时范围不包含旧收录，日期归档仍即时覆盖全部历史", async () => {
  const headers = await auth();
  const old = await upsertMaterial({ sourceId: "intelligence-news", title: "更早收录的制作背景", url: "https://news.example/older-background", via: "import",
    discoveredAt: new Date(Date.now() - 36 * 3600_000), publishedAt: new Date(Date.now() - 72 * 3600_000), bodyText: "这条仅用于历史检索。", bodyStatus: "ok" });
  const recent = (await app.inject({ url: "/api/admin/studio/intelligence?recent=24h&limit=10", headers })).json();
  assert.ok(recent.rows.every((row: { collectedAt: string }) => Date.parse(row.collectedAt) >= Date.now() - 24 * 3600_000));
  assert.equal(recent.rows.some((row: { id: string }) => row.id === `news:${old.articleId}`), false);
  const archive = (await app.inject({ url: "/api/admin/studio/intelligence?q=" + encodeURIComponent("更早收录"), headers })).json();
  assert.equal(archive.total, 1); assert.equal(archive.rows[0].id, `news:${old.articleId}`);
  const dates = (await app.inject({ url: "/api/admin/studio/intelligence/dates?q=" + encodeURIComponent("更早收录"), headers })).json();
  assert.equal(dates.days.reduce((sum: number, day: { total: number }) => sum + day.total, 0), 1);
});

test("移除新闻源和博主只停止后续关注，已收录情报与详情仍可追溯", async () => {
  const headers = await auth();
  const before = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json();
  const source = (await app.inject({ url: "/api/admin/studio/news-sources?q=intelligence-news", headers })).json().rows[0];
  const creator = (await app.inject({ url: "/api/admin/studio/creators?platform=bilibili", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${source.id}/archive`, headers,
    payload: { version: source.version, archived: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/creators/${creator.id}/archive`, headers,
    payload: { version: creator.version, archived: true } })).statusCode, 200);
  const after = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json();
  assert.equal(after.total, before.total); assert.deepEqual(after.rows.map((row: { id: string }) => row.id), before.rows.map((row: { id: string }) => row.id));
  for (const row of after.rows) assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${encodeURIComponent(row.id)}`, headers })).statusCode, 200);
});
