import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true;
const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("新闻来源同时满足三次连续失败及48小时才置顶提示，真实成功一次立即解除", async () => {
  for (const [id, name, count, hours] of [["warning-news", "最后排的故障源", 3, 49], ["short-news", "A短时故障源", 3, 24], ["two-news", "B仅两次故障源", 2, 49]] as const) {
    const added = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name, kind: "rss", config: { feedUrl: `https://health.example/${id}/rss` }, enabled: true } });
    assert.equal(added.statusCode, 200);
    // Form the actual consecutive failures through the collector; only elapsed time is a fixture.
    for (let index = 0; index < count; index++) {
      transport.get("https://health.example").intercept({ path: `/${id}/rss` }).reply(503, "temporarily unavailable");
      assert.equal((await collectSource(id, { force: true })).status, "failed");
    }
    await sql`UPDATE sources SET created_at = now() - interval '4 days' WHERE id = ${id}`;
    const runs = await sql<{ id: number }[]>`SELECT id FROM fetch_runs WHERE source_id = ${id} ORDER BY id`;
    assert.equal(runs.length, count);
    for (let index = 0; index < count; index++) {
      const ago = hours * (count - index - 1) / (count - 1);
      await sql`UPDATE fetch_runs SET started_at = now() - make_interval(secs => ${ago * 3600}),
        finished_at = now() - make_interval(secs => ${ago * 3600}) WHERE id = ${runs[index]!.id}`;
    }
  }
  const cards = () => app.inject({ url: "/api/admin/studio/news-sources?limit=1", headers });
  const first = (await cards()).json(); assert.equal(first.rows[0].id, "warning-news"); assert.equal(first.rows[0].failureWarning.count, 3);
  const others = (await app.inject({ url: "/api/admin/studio/news-sources?limit=10", headers })).json().rows;
  assert.equal(others.find((row: { id: string }) => row.id === "short-news").failureWarning, null);
  assert.equal(others.find((row: { id: string }) => row.id === "two-news").failureWarning, null);
  transport.get("https://health.example").intercept({ path: "/warning-news/rss" }).reply(200, "<rss><channel><title>恢复成功</title></channel></rss>", { headers: { "content-type": "application/rss+xml" } });
  assert.equal((await collectSource("warning-news", { force: true })).status, "ok");
  const recovered = (await app.inject({ url: "/api/admin/studio/news-sources?q=warning-news", headers })).json().rows[0];
  assert.equal(recovered.failureWarning, null); assert.equal(recovered.health, "ok");
  assert.notEqual((await cards()).json().rows[0].id, "warning-news");
  transport.assertNoPendingInterceptors();
});

test("预算等待不会挤掉来源真实连续失败的48小时证据，也不会清除告警", async () => {
  process.env.SOCIALDATA_API_KEY = "fixture-key";
  process.env.SOCIALDATA_BASE_URL = "https://health-social.example";
  const budget = (limit: number) => app.inject({ method: "PUT", url: "/api/admin/budgets/socialdata", headers,
    payload: { perMinute: limit, perHour: limit, perDay: limit, reason: "fixture budget boundary" } });
  assert.equal((await budget(1000)).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "budget-news", name: "预算等待来源", kind: "x_search", config: { query: "from:fixture" }, enabled: true } })).statusCode, 200);
  for (let index = 0; index < 3; index++) {
    transport.get("https://health-social.example").intercept({ path: /\/twitter\/search\?/ }).reply(400, "fixture rejection");
    assert.equal((await collectSource("budget-news", { force: true })).status, "failed");
  }
  const runs = await sql<{ id: number }[]>`SELECT id FROM fetch_runs WHERE source_id = 'budget-news' ORDER BY id`;
  await sql`UPDATE sources SET created_at = now() - interval '4 days' WHERE id = 'budget-news'`;
  for (const [index, hours] of [49, 25, 0].entries()) await sql`UPDATE fetch_runs
    SET started_at = now() - make_interval(secs => ${hours * 3600}), finished_at = now() - make_interval(secs => ${hours * 3600}) WHERE id = ${runs[index]!.id}`;
  const card = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=budget-news", headers })).json().rows[0];
  assert.equal((await card()).failureWarning.count, 3);
  assert.equal((await budget(0)).statusCode, 200);
  assert.match((await collectSource("budget-news", { force: true })).error!, /Budget for socialdata exhausted/);
  assert.equal((await card()).failureWarning?.count, 3);
  transport.assertNoPendingInterceptors();
});
