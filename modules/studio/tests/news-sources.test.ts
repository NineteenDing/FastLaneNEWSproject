import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
const previous = getGlobalDispatcher();
const transport = new MockAgent();
transport.disableNetConnect();
setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
let checkedAfter = 0;
let checkedBefore = 0;
after(async () => {
  setGlobalDispatcher(previous);
  await transport.close();
  await app.close();
  await stopBoss();
  await closeDb();
});

before(async () => {
  const cookie = await login();
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  const headers = { cookie, "x-csrf-token": me.json().csrf };
  const rss = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "studio-rss", name: "创作新闻", kind: "rss", tags: ["影视"],
      config: { feedUrl: "https://news.example/feed?token=private-fixture" } } });
  assert.equal(rss.statusCode, 200);
  const external = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "studio-external", name: "外部桥接", kind: "external", tags: ["工具"], config: {} } });
  assert.equal(external.statusCode, 200);
  const paused = await app.inject({ method: "PATCH", url: "/api/admin/sources/studio-external", headers,
    payload: { version: external.json().source.updated_at, patch: { enabled: false } } });
  assert.equal(paused.statusCode, 200);
  transport.get("https://news.example").intercept({ path: "/feed?token=private-fixture" })
    .reply(200, '<rss version="2.0"><channel><title>创作新闻</title></channel></rss>');
  checkedAfter = Date.now();
  assert.equal((await collectSource("studio-rss")).status, "ok");
  checkedBefore = Date.now();
});

test("关注库必须登录，匿名请求不返回来源", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/studio/news-sources" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
});

async function login() {
  config.adminPassword = "studio-test-password-only";
  const response = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "username=admin&password=studio-test-password-only&return=/admin" });
  assert.equal(response.statusCode, 303);
  return String(response.headers["set-cookie"]).split(";")[0];
}

test("登录后能查看真实来源和启停分组，缺失资料不伪造，采集凭据不发到页面", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/studio/news-sources", headers: { cookie: await login() } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const data = response.json();
  assert.equal(data.total, 2);
  const rss = data.rows.find((row: { id: string }) => row.id === "studio-rss");
  assert.equal(rss.name, "创作新闻");
  assert.deepEqual(rss.tags, ["影视"]);
  assert.equal(rss.enabled, true);
  const checked = Date.parse(rss.lastCheckedAt);
  assert.ok(checked >= checkedAfter && checked <= checkedBefore);
  assert.equal(rss.health, "ok");
  assert.equal(rss.latestPublishedAt, null);
  assert.equal(rss.collectedCount, 0);
  assert.equal(rss.description, null);
  assert.equal(rss.region, null);
  assert.equal(rss.language, null);
  assert.equal(data.rows.find((row: { id: string }) => row.id === "studio-external").enabled, false);
  assert.ok(!response.body.includes("private-fixture"));
  assert.ok(!response.body.includes('"config"'));
  assert.ok(!response.body.includes('"last_error"'));
});

test("按名称和启停状态筛选并分页，搜索不读取私密配置", async () => {
  const headers = { cookie: await login() };
  const read = async (query: string) => app.inject({ method: "GET", url: `/api/admin/studio/news-sources?${query}`, headers });
  const first = (await read("limit=1")).json();
  const second = (await read("limit=1&page=2")).json();
  assert.equal(first.total, 2);
  assert.equal(first.rows.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(second.rows.length, 1);
  assert.equal(second.hasMore, false);
  assert.notEqual(first.rows[0].id, second.rows[0].id);
  const paused = (await read("enabled=false")).json();
  assert.equal(paused.total, 1);
  assert.equal(paused.rows[0].id, "studio-external");
  assert.equal((await read("q=" + encodeURIComponent("创作"))).json().total, 1);
  assert.equal((await read("q=private-fixture")).json().total, 0);
  assert.equal((await read("q=%25")).json().total, 0, "percent is literal search text, not a wildcard");
  for (const query of ["page=0", "limit=101", "enabled=banana", "page=1.5"]) {
    assert.equal((await read(query)).statusCode, 400);
  }
});

test("多个来源发现同一材料时，各来源都保留收录统计，重复采集不重复计数", async () => {
  const cookie = await login();
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  const headers = { cookie, "x-csrf-token": me.json().csrf };
  const added = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "studio-secondary", name: "另一新闻源", kind: "rss",
      config: { feedUrl: "https://news.example/secondary.xml", fetchPublicContent: false } } });
  assert.equal(added.statusCode, 200);
  const published = new Date(Math.floor((Date.now() - 60000) / 1000) * 1000);
  const feed = `<rss version="2.0"><channel><title>创作新闻</title><item>
    <title>镜头控制工具更新</title><link>https://publisher.example/update</link>
    <pubDate>${published.toUTCString()}</pubDate><description>更新了镜头控制参数。</description>
    </item></channel></rss>`;
  transport.get("https://news.example").intercept({ path: "/feed?token=private-fixture" }).reply(200, feed);
  transport.get("https://news.example").intercept({ path: "/secondary.xml" }).reply(200, feed).times(2);
  for (const id of ["studio-rss", "studio-secondary", "studio-secondary"]) {
    assert.equal((await collectSource(id, { force: true })).status, "ok");
  }
  const response = await app.inject({ url: "/api/admin/studio/news-sources", headers });
  assert.equal(response.statusCode, 200);
  for (const id of ["studio-rss", "studio-secondary"]) {
    const card = response.json().rows.find((row: { id: string }) => row.id === id);
    assert.equal(card.collectedCount, 1, `${id} has discovered one distinct article`);
    assert.equal(card.latestPublishedAt, published.toISOString());
  }
});
