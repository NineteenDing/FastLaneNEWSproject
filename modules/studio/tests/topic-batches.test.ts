import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app } = resources;
await resources.warm();
after(async () => { await app.close(); await closeDb(); });
let session: { cookie: string; "x-csrf-token": string };
async function auth() {
  if (session) return session;
  config.adminPassword = "topic-batch-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=topic-batch-test-password" });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  session = { cookie, "x-csrf-token": me.json().csrf }; return session;
}

test("选题当期按香港20点的固定相邻两日窗口切换，不生成重叠滚动日报，读取不冒充已完成推荐", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T11:59:59.999Z") });
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current" })).statusCode, 401);
  const before = await app.inject({ url: "/api/admin/studio/topic-batches/current", headers });
  assert.equal(before.statusCode, 200); assert.equal(before.headers["cache-control"], "no-store");
  assert.equal(before.json().startsAt, "2026-10-16T12:00:00.000Z");
  assert.equal(before.json().endsAt, "2026-10-18T12:00:00.000Z");
  assert.equal(before.json().timeZone, "Asia/Hong_Kong");
  assert.equal(before.json().stage, "collecting"); assert.equal(before.json().recommendationState, "not_generated");
  t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime());
  const next = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  assert.equal(next.startsAt, "2026-10-18T12:00:00.000Z"); assert.equal(next.endsAt, "2026-10-20T12:00:00.000Z");
});

test("截止后冻结收录窗口内完整材料和栏目，边界不重复，改名或更新正文不改写历史，重复冻结返回同一批次", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00Z") });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "batch-news", name: "视频创作新闻", kind: "rss", config: { feedUrl: "https://batch.example/rss?token=hidden-source-token" } } })).statusCode, 200);
  const inside = await upsertMaterial({ sourceId: "batch-news", title: "首个角色控制更新", url: "https://batch.example/first", via: "import",
    discoveredAt: new Date("2026-10-16T12:00:00Z"), publishedAt: new Date("2026-10-10T08:00:00Z"),
    excerpt: "有使用限制", bodyText: "完整正文：角色控制需要固定参考图，未验证多角色场景。".repeat(30), bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "batch-news", title: "前一批旧新闻", url: "https://batch.example/before", via: "import",
    discoveredAt: new Date("2026-10-16T11:59:59.999Z"), excerpt: "不属于本批" });
  const boundary = await upsertMaterial({ sourceId: "batch-news", title: "下一批更新", url: "https://batch.example/next", via: "import",
    discoveredAt: new Date("2026-10-18T12:00:00Z"), excerpt: "属于下一批" });
  const freeze = (startsAt: string) => app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } });
  const frozen = await freeze("2026-10-16T12:00:00.000Z");
  assert.equal(frozen.statusCode, 200);
  const original = frozen.json().batch;
  assert.equal(original.materialCount, 1); assert.equal(original.adoptionState, "not_adopted");
  assert.equal(original.stage, "frozen"); assert.equal(original.recommendationState, "not_generated");
  assert.equal(original.audience, "关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者");
  assert.equal(original.columns[0].name, "实操与提效"); assert.equal(original.columns[0].version, 2);
  const readMaterials = () => app.inject({ url: `/api/admin/studio/topic-batches/${original.id}/materials`, headers });
  const material = (await readMaterials()).json().rows[0];
  assert.equal(material.id, "news:" + inside.articleId); assert.equal(material.source.name, "视频创作新闻");
  assert.equal(material.body, "完整正文：角色控制需要固定参考图，未验证多角色场景。".repeat(30));
  assert.equal(material.publishedAt, "2026-10-10T08:00:00.000Z"); assert.equal(material.bodyState, "ok");
  assert.ok(!frozen.body.includes("hidden-source-token"));
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers,
    payload: { version: 2, name: "更名后的栏目" } })).statusCode, 200);
  await upsertMaterial({ sourceId: "batch-news", title: "已修正的角色更新", url: "https://batch.example/first", via: "import",
    discoveredAt: new Date("2026-10-20T10:00:00Z"), bodyText: "新正文已更正", bodyStatus: "ok" });
  assert.deepEqual((await readMaterials()).json().rows[0], material);
  assert.deepEqual((await app.inject({ url: `/api/admin/studio/topic-batches/${original.id}`, headers })).json().batch, original);
  assert.deepEqual((await freeze("2026-10-16T12:00:00.000Z")).json().batch, original);
  const next = (await freeze("2026-10-18T12:00:00.000Z")).json().batch;
  assert.equal(next.materialCount, 1); assert.equal(next.columns[0].name, "更名后的栏目");
  assert.equal((await app.inject({ url: `/api/admin/studio/topic-batches/${next.id}/materials`, headers })).json().rows[0].id, "news:" + boundary.articleId);
  const history = await app.inject({ url: "/api/admin/studio/topic-batches", headers });
  assert.equal(history.statusCode, 200); assert.equal(history.json().total, 2);
  assert.equal(history.json().rows[0].id, next.id); assert.equal(history.json().rows[0].adoptionState, "not_adopted");
});

test("旧新闻与首次补收保留背景标记和版本依据，未知日期不冒充新热点", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const inputs = [
    { title: "本期新功能", url: "https://batch.example/fresh", publishedAt: new Date("2026-10-21T08:00:00Z") },
    { title: "补收的旧价格", url: "https://batch.example/old", publishedAt: new Date("2026-10-01T08:00:00Z") },
    { title: "首次导入的存量", url: "https://batch.example/backfill", publishedAt: new Date("2026-10-21T08:00:00Z"), backfill: "first-import" },
    { title: "发布时间待核实", url: "https://batch.example/unknown" },
  ];
  for (const input of inputs) await upsertMaterial({ sourceId: "batch-news", via: "import", discoveredAt: new Date("2026-10-21T10:00:00Z"), bodyText: "有来源的正文", bodyStatus: "ok", ...input });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-20T12:00:00.000Z" } });
  assert.equal(frozen.statusCode, 200);
  const materials = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers })).json().rows;
  const byTitle = (title: string) => materials.find((row: { title: string }) => row.title === title);
  assert.equal(byTitle("本期新功能").freshness, "current");
  assert.equal(byTitle("补收的旧价格").freshness, "background");
  assert.equal(byTitle("首次导入的存量").freshness, "background");
  assert.equal(byTitle("发布时间待核实").freshness, "undated");
  assert.equal(byTitle("本期新功能").contentVersion.revision, 1);
  assert.match(byTitle("本期新功能").contentVersion.fingerprint, /^[0-9a-f]{64}$/);
});

test("完整冻结超过一页的材料，分页不会截断覆盖；截止后新增内容进入下一窗口而不补写旧快照", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T12:00:00Z") });
  for (let index = 0; index < 33; index++) await upsertMaterial({ sourceId: "batch-news", title: `完整材料${index}`, url: `https://batch.example/full-${index}`,
    via: "import", discoveredAt: new Date("2026-10-23T10:00:00Z"), bodyText: `第${index}条的全文`, bodyStatus: "ok" });
  const freeze = () => app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-22T12:00:00.000Z" } });
  const concurrent = await Promise.all([freeze(), freeze()]);
  assert.ok(concurrent.every(response => response.statusCode === 200));
  assert.equal(concurrent[0]!.json().batch.id, concurrent[1]!.json().batch.id);
  const batch = concurrent[0]!.json().batch; assert.equal(batch.materialCount, 33);
  const read = (query = "") => app.inject({ url: `/api/admin/studio/topic-batches/${batch.id}/materials${query}`, headers });
  const first = (await read()).json(), second = (await read("?page=2")).json();
  assert.equal(first.rows.length, 30); assert.equal(first.total, 33); assert.equal(first.hasMore, true);
  assert.equal(second.rows.length, 3); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 33);
  const late = await upsertMaterial({ sourceId: "batch-news", title: "晚收到的原日新闻", url: "https://batch.example/late", via: "import",
    discoveredAt: new Date("2026-10-24T12:00:00Z"), publishedAt: new Date("2026-10-23T08:00:00Z"), bodyText: "晚发现但已如实保留原发布日期", bodyStatus: "ok" });
  assert.equal((await read()).json().total, 33);
  const next = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-24T12:00:00.000Z" } });
  assert.equal(next.statusCode, 200); assert.equal(next.json().batch.materialCount, 1);
  const nextMaterials = (await app.inject({ url: `/api/admin/studio/topic-batches/${next.json().batch.id}/materials`, headers })).json();
  assert.equal(nextMaterials.rows[0].id, "news:" + late.articleId); assert.equal(nextMaterials.rows[0].freshness, "background");
  assert.equal((await read("?limit=101")).statusCode, 400);
});

test("未截止或未对齐批次不能冻结，私有历史与材料拒绝游客及缺CSRF写入，未知批次明确404", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T11:59:59.999Z") });
  for (const startsAt of ["2026-10-24T12:00:00.000Z", "2026-10-23T12:00:00.000Z", "2026-10-22T13:00:00.000Z"])
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt } })).statusCode, 409);
  const missing = "00000000-0000-0000-0000-000000000000";
  for (const path of ["", `/${missing}`, `/${missing}/materials`]) {
    assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches" + path })).statusCode, 401);
    if (path) assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches" + path, headers })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers: { cookie: headers.cookie },
    payload: { startsAt: "2026-10-22T12:00:00.000Z" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers,
    payload: { startsAt: "2026-10-22T12:00:00.000Z", allowOverlap: true } })).statusCode, 400);
});

test("截止前开始但冻结后才提交的材料会在下一批补收，旧快照保持不变且不重复归属", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-30T12:00:00Z") });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const inserting = sql.begin(async db => {
    const material = await upsertMaterial({ sourceId: "batch-news", title: "截止时尚在提交的更新", url: "https://batch.example/in-flight", via: "import",
      discoveredAt: new Date("2026-10-28T11:59:59Z"), publishedAt: new Date("2026-10-28T11:00:00Z"), bodyText: "冻结后才完成入库的完整内容", bodyStatus: "ok" }, db);
    entered.resolve(); await release.promise; return material;
  });
  let committed: Awaited<typeof inserting>;
  let earlier: { id: string };
  try {
    await entered.promise;
    const response = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-26T12:00:00.000Z" } });
    assert.equal(response.statusCode, 200); earlier = response.json().batch; assert.equal(response.json().batch.materialCount, 0);
  } finally { release.resolve(); committed = await inserting; }
  t.mock.timers.setTime(new Date("2026-10-28T12:00:00Z").getTime());
  const preview = await app.inject({ url: "/api/admin/studio/topic-batches/current", headers });
  assert.equal(preview.statusCode, 200); assert.equal(preview.json().materialCount, 1); assert.equal(preview.json().analysisPendingCount, 1);
  const previewRows = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json().rows;
  assert.equal(previewRows[0].id, "news:" + committed.articleId); assert.equal(previewRows[0].arrivedLate, true);
  t.mock.timers.setTime(new Date("2026-10-30T12:00:00Z").getTime());
  const next = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-28T12:00:00.000Z" } });
  assert.equal(next.statusCode, 200); assert.equal(next.json().batch.materialCount, 1);
  const read = (id: string) => app.inject({ url: `/api/admin/studio/topic-batches/${id}/materials`, headers });
  const material = (await read(next.json().batch.id)).json().rows[0];
  assert.equal(material.id, "news:" + committed.articleId); assert.equal(material.arrivedLate, true);
  assert.equal(material.collectedAt, "2026-10-28T11:59:59.000Z"); assert.equal((await read(earlier!.id)).json().total, 0);
  t.mock.timers.setTime(new Date("2026-11-05T12:00:00Z").getTime());
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers,
    payload: { startsAt: "2026-11-01T12:00:00.000Z" } })).statusCode, 409);
  const following = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-30T12:00:00.000Z" } });
  assert.equal(following.statusCode, 200); assert.equal(following.json().batch.materialCount, 0);
});

test("当期预览只显示本收录窗口的实际材料和处理缺口，读取不会创建历史批次", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T11:00:00Z") });
  await upsertMaterial({ sourceId: "batch-news", title: "本期可查看的材料", url: "https://batch.example/current", via: "import",
    discoveredAt: new Date("2026-11-04T10:00:00Z"), publishedAt: new Date("2026-11-04T09:00:00Z"), bodyText: "当前完整正文", bodyStatus: "ok" });
  const historyBefore = (await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total;
  const current = await app.inject({ url: "/api/admin/studio/topic-batches/current", headers });
  assert.equal(current.statusCode, 200); assert.equal(current.json().materialCount, 1);
  assert.equal(current.json().analysisPendingCount, 1); assert.equal(current.json().videoWithoutTranscriptCount, 0);
  const materials = await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers });
  assert.equal(materials.statusCode, 200); assert.equal(materials.headers["cache-control"], "no-store");
  assert.equal(materials.json().total, 1); assert.equal(materials.json().rows[0].title, "本期可查看的材料");
  assert.equal(materials.json().rows[0].body, "当前完整正文");
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches", headers })).json().total, historyBefore);
  assert.equal((await app.inject({ url: "/api/admin/studio/topic-batches/current/materials" })).statusCode, 401);
});

test("尚未冻结的历史窗口材料留在原批次，不因截止任务积压而被当期误标迟到补收", async t => {
  const headers = await auth();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-05T11:00:00Z") });
  const pending = await upsertMaterial({ sourceId: "batch-news", title: "积压历史窗口中的正常材料", url: "https://batch.example/pending-period", via: "import",
    discoveredAt: new Date("2026-11-02T10:00:00Z"), publishedAt: new Date("2026-11-02T09:00:00Z"), bodyText: "仍应归属十一月一日至三日的窗口", bodyStatus: "ok" });
  const preview = () => app.inject({ url: "/api/admin/studio/topic-batches/current", headers });
  assert.equal((await preview()).json().materialCount, 1);
  const rows = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json().rows;
  assert.ok(!rows.some((row: { id: string }) => row.id === "news:" + pending.articleId));
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-11-01T12:00:00.000Z" } });
  assert.equal(frozen.statusCode, 200); assert.equal(frozen.json().batch.materialCount, 1);
  const saved = (await app.inject({ url: `/api/admin/studio/topic-batches/${frozen.json().batch.id}/materials`, headers })).json().rows;
  assert.equal(saved[0].id, "news:" + pending.articleId); assert.equal(saved[0].arrivedLate, false);
  assert.equal((await preview()).json().materialCount, 1);
});
