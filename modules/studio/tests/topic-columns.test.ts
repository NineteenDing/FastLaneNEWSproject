import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });
let session: { cookie: string; "x-csrf-token": string };
async function auth() {
  if (session) return session;
  config.adminPassword = "topic-column-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=topic-column-test-password" });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  session = { cookie, "x-csrf-token": me.json().csrf }; return session;
}

test("私有选题栏目具有固定受众、四个主栏目和保留的其他，默认规则与方向数量来自定稿", async () => {
  const headers = await auth();
  assert.equal((await app.inject({ url: "/api/admin/studio/columns" })).statusCode, 401);
  const response = await app.inject({ url: "/api/admin/studio/columns", headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const result = response.json();
  assert.equal(result.audience, "关注AI影像、视频、音乐、影视、漫剧及相关创作和观看体验的创作者、摄影师、编剧、制片人、演员、行业从业者与爱好者");
  assert.deepEqual(result.rows.map((row: { name: string }) => row.name), ["实操与提效", "模型与工具", "新闻与实际影响", "作品与案例", "其他"]);
  assert.deepEqual(result.rows.map((row: { maxDirections: number }) => row.maxDirections), [3, 3, 3, 3, 5]);
  assert.ok(result.rows.every((row: { version: number; questions: string; videoForms: string }) => row.version === 2 && row.questions && row.videoForms));
  assert.equal(result.rows[4].isFallback, true); assert.equal(result.rows[0].isFallback, false);
});

test("新增与修改栏目持久保存独立版本，改名或修改规则仍可读取当时的完整标准", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/columns", headers,
    payload: { name: "声音与口型", questions: "配音自然度、多人对白与口型同步", videoForms: "录屏演示、制作前后对比" } });
  assert.equal(created.statusCode, 200);
  const original = created.json().column;
  assert.equal(original.version, 1); assert.equal(original.maxDirections, 3); assert.equal(original.isFallback, false);
  assert.ok(original.requirements.includes("核心事实有来源"));
  const changed = await app.inject({ method: "PATCH", url: `/api/admin/studio/columns/${original.id}`, headers,
    payload: { version: 1, name: "配音与口型", questions: "对白口型衔接与低成本配音", enabled: false, sortOrder: 1 } });
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().column.version, 2);
  const rows = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows;
  assert.equal(rows.length, 6); assert.equal(rows[0].id, original.id); assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].name, "配音与口型"); assert.equal(rows.at(-1).id, "other");
  const history = await app.inject({ url: `/api/admin/studio/columns/${original.id}/versions/1`, headers });
  assert.equal(history.statusCode, 200); assert.deepEqual(history.json().column, original);
  const practice = rows.find((row: { id: string }) => row.id === "practice");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers,
    payload: { version: 2, name: "操作提效", requirements: "必须附参数和步骤，保留来源与适用条件。" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/studio/columns/practice/versions/1", headers })).json().column.name, "实操与提效");
  assert.deepEqual((await app.inject({ url: "/api/admin/studio/columns/practice/versions/2", headers })).json().column, practice);
  assert.equal((await app.inject({ url: "/api/admin/studio/columns/practice/versions/3", headers })).json().column.name, "操作提效");
  assert.equal((await app.inject({ url: "/api/admin/studio/columns/practice/versions/4", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/admin/studio/columns/practice/versions/1" })).statusCode, 401);
});

test("栏目多窗口冲突不会覆盖更新，其他不能停用或改名，非法配置与重复名称明确拒绝", async () => {
  const headers = await auth();
  const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/admin/studio/columns/${id}`, headers, payload });
  assert.equal((await patch("news", { version: 1, name: "过期窗口" })).statusCode, 409);
  const simultaneous = await Promise.all([patch("models", { version: 2, name: "制作工具" }), patch("models", { version: 2, name: "模型比较" })]);
  assert.deepEqual(simultaneous.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal((await patch("other", { version: 2, enabled: false })).statusCode, 409);
  assert.equal((await patch("other", { version: 2, name: "随意分组" })).statusCode, 409);
  const create = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/admin/studio/columns", headers, payload });
  assert.equal((await create({ name: "配音与口型", questions: "重复", videoForms: "演示" })).statusCode, 409);
  for (const payload of [
    { name: "空问题", questions: " ", videoForms: "演示" },
    { name: "无稿型", questions: "人物一致性" },
    { name: "覆盖系统栏", questions: "人物一致性", videoForms: "演示", isFallback: true },
  ]) assert.equal((await create(payload)).statusCode, 400);
  const other = (await app.inject({ url: "/api/admin/studio/columns", headers })).json().rows.at(-1);
  assert.equal(other.id, "other"); assert.equal(other.version, 2); assert.equal(other.enabled, true); assert.equal(other.name, "其他");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/columns", headers: { cookie: headers.cookie },
    payload: { name: "缺少防护", questions: "人物一致性", videoForms: "演示" } })).statusCode, 403);
});
