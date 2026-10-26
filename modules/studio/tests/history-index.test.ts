import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("私人历史按中文关键词召回旧新闻，限定截止时间，不依赖公开精选或调用模型", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "history-news", name: "历史制作资料", kind: "rss", config: { feedUrl: "https://history.example/feed?token=hidden-source-secret" } } })).statusCode, 200);
  const older = await upsertMaterial({ sourceId: "history-news", title: "角色一致性旧版教程", url: "https://history.example/older", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), publishedAt: new Date("2026-10-09T08:00:00Z"),
    bodyText: "角色一致性依靠参考图，先验证单人镜头。", bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "history-news", title: "角色一致性当期材料", url: "https://history.example/current", via: "import",
    discoveredAt: new Date("2026-10-18T12:00:00Z"), bodyText: "角色一致性新功能", bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "history-news", title: "无关天气", url: "https://history.example/weather", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), bodyText: "今天是晴天", bodyStatus: "ok" });
  const url = "/api/admin/studio/history?q=" + encodeURIComponent("角色一致性") + "&before=2026-10-18T12:00:00.000Z";
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const result = response.json(); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, "news:" + older.articleId); assert.equal(result.rows[0].title, "角色一致性旧版教程");
  assert.equal(result.rows[0].publishedAt, "2026-10-09T08:00:00.000Z"); assert.equal(result.rows[0].contentVersion.revision, 1);
  assert.equal(result.rows[0].source.name, "历史制作资料"); assert.ok(result.rows[0].matchedTerms.includes("角色"));
  assert.ok(!response.body.includes("hidden-source-secret")); assert.equal(result.rows[0].body, undefined);
  assert.equal((await app.inject({ url })).statusCode, 401);
});

test("中文工具名与英文别名召回同一来源，仍保留原名和真实版本", async () => {
  const item = await upsertMaterial({ sourceId: "history-news", title: "可灵镜头参考的使用条件", url: "https://history.example/kling", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), bodyText: "可灵需要先设置参考图。", bodyStatus: "ok" });
  const result = await app.inject({ url: "/api/admin/studio/history?q=KLING", headers }); assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().rows.map((row: { id: string }) => row.id), ["news:" + item.articleId]);
  assert.equal(result.json().rows[0].title, "可灵镜头参考的使用条件");
});

test("关注博主作品通过真实采集事务进入同一私有索引，返回平台和内容版本", async () => {
  const following = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(following.statusCode, 200); const id = following.json().creator.id;
  bilibiliFixture(transport, { description: "BloggerAnchorOnly：先锁定参考，再组织镜头" });
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
  const queue = SERVER_MODULES.find(m => m.name === "studio")!.queues!.find(q => q.name === "studio.creator.collect")!, boss = await getBoss();
  const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const result = await app.inject({ url: "/api/admin/studio/history?q=BloggerAnchorOnly", headers }); assert.equal(result.statusCode, 200);
  const rows = result.json().rows; assert.equal(rows.length, 1); assert.equal(rows[0].kind, "video");
  assert.equal(rows[0].source.platform, "bilibili"); assert.equal(rows[0].source.name, "影视流程研究");
  assert.ok(rows[0].id.startsWith("creator:")); assert.equal(typeof rows[0].contentVersion.fingerprint, "string");
  transport.assertNoPendingInterceptors();
});

test("原稿更正替换当前检索词和版本，已经冻结的材料仍保留当时正文", async t => {
  await resources.warm();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  const input = { sourceId: "history-news", title: "制作限制更正示例", url: "https://history.example/correction", via: "import",
    discoveredAt: new Date("2026-10-16T13:00:00Z"), publishedAt: new Date("2026-10-16T12:30:00Z"), bodyStatus: "ok" as const };
  const item = await upsertMaterial({ ...input, bodyText: "OldAnchorOnly：原始限制。" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00.000Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`;
  const snapshot = (await app.inject({ url, headers })).json().rows.find((row: { id: string }) => row.id === "news:" + item.articleId);
  assert.equal(snapshot.body, "OldAnchorOnly：原始限制。");
  await upsertMaterial({ ...input, bodyText: "NewAnchorOnly：更正后的限制。" });
  const old = await app.inject({ url: "/api/admin/studio/history?q=OldAnchorOnly", headers }); assert.equal(old.json().rows.length, 0);
  const current = (await app.inject({ url: "/api/admin/studio/history?q=NewAnchorOnly", headers })).json().rows;
  assert.equal(current.length, 1); assert.equal(current[0].contentVersion.revision, 2);
  assert.deepEqual((await app.inject({ url, headers })).json().rows.find((row: { id: string }) => row.id === snapshot.id), snapshot);
});

test("历史候选有界返回最近材料，参数不能扩大上限或绕过登录", async () => {
  for (let index = 0; index < 55; index++) {
    const date = new Date(Date.UTC(2026, 9, 1, 0, index));
    await upsertMaterial({ sourceId: "history-news", title: `HistoryLimitToken ${index}`, url: `https://history.example/limit-${index}`, via: "import",
      discoveredAt: date, publishedAt: date, bodyText: "有出处的制作步骤", bodyStatus: "ok" });
  }
  const result = await app.inject({ url: "/api/admin/studio/history?q=HistoryLimitToken", headers }); assert.equal(result.statusCode, 200);
  assert.equal(result.json().rows.length, 50); assert.equal(result.json().rows[0].title, "HistoryLimitToken 54");
  assert.equal((await app.inject({ url: "/api/admin/studio/history?q=HistoryLimitToken&limit=3", headers })).json().rows.length, 3);
  for (const query of ["", "q=", "q=%25", "q=x&limit=51", "q=x&before=invalid"])
    assert.equal((await app.inject({ url: "/api/admin/studio/history?" + query, headers })).statusCode, 400);
});

test("不完整的标题关键词可通过模糊索引找到原材料，检索通配符按普通文字处理", async () => {
  const item = await upsertMaterial({ sourceId: "history-news", title: "UniqueHistoryTitle", url: "https://history.example/title-fragment", via: "import",
    discoveredAt: new Date("2026-10-10T10:00:00Z"), bodyText: "镜头制作步骤", bodyStatus: "ok" });
  const result = await app.inject({ url: "/api/admin/studio/history?q=HistoryTit", headers }); assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().rows.map((row: { id: string }) => row.id), ["news:" + item.articleId]);
  const wildcard = await app.inject({ url: "/api/admin/studio/history?q=HistoryTit%25", headers });
  assert.equal(wildcard.statusCode, 200); assert.equal(wildcard.json().rows.length, 0);
});

test("数据库拒绝索引写入时原文也不单独提交，恢复后通过原入口可安全重试", async () => {
  const input = { sourceId: "history-news", title: "IndexRollbackMarker", url: "https://history.example/atomic", via: "import", bodyText: "完整原文", bodyStatus: "ok" as const };
  await sql.unsafe(`CREATE FUNCTION test_reject_history_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.title = 'IndexRollbackMarker' THEN RAISE EXCEPTION 'history-storage-test-refused'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER test_history_write BEFORE INSERT OR UPDATE ON studio_history_index FOR EACH ROW EXECUTE FUNCTION test_reject_history_write()");
  try {
    await assert.rejects(upsertMaterial(input), /history-storage-test-refused/);
    const detail = await app.inject({ url: "/api/admin/studio/intelligence?q=IndexRollbackMarker", headers });
    assert.equal(detail.statusCode, 200); assert.equal(detail.json().total, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER test_history_write ON studio_history_index");
    await sql.unsafe("DROP FUNCTION test_reject_history_write()");
  }
  const saved = await upsertMaterial(input); assert.equal(saved.created, true);
  const index = (await app.inject({ url: "/api/admin/studio/history?q=IndexRollbackMarker", headers })).json().rows;
  assert.equal(index.length, 1); assert.equal(index[0].id, "news:" + saved.articleId); assert.equal(index[0].contentVersion.revision, 1);
});
