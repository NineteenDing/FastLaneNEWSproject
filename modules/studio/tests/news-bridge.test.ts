import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
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
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });
async function auth() {
  config.adminPassword = "studio-bridge-test-password";
  const login = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-bridge-test-password" });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf as string };
}
const endpoint = (id: string) => `/api/admin/studio/news-sources/${id}/bridge`;

test("既有外部来源可读取原RSSHub路由配置，缺少运行服务时不伪装已连接", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "src-qwen-blog", name: "千问原来源", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  const response = await app.inject({ url: endpoint("src-qwen-blog"), headers });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["cache-control"]), /no-store/);
  const data = response.json();
  assert.equal(data.id, "src-qwen-blog");
  assert.equal(data.name, "千问原来源");
  assert.equal(data.route, "/qwen/blog");
  assert.equal(data.itemLimit, 8);
  assert.equal(data.aiFilter, false);
  assert.equal(data.origin, "legacy");
  assert.equal(data.version, created.json().source.updated_at);
  assert.equal(data.runtimeState, "not_configured");
  assert.ok(!response.body.includes("INGEST_TOKEN"));
});

test("编辑桥接路由后沿用来源身份、保留资料并先暂停，不读取上游或更改发布方配置", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "custom-bridge", name: "自定义桥接", kind: "external", config: { publisherRole: "organization" } } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/custom-bridge/profile", headers,
    payload: { version: 0, description: "人工简介", region: "中国", language: "中文", homepage: null } })).statusCode, 200);
  const response = await app.inject({ method: "PUT", url: endpoint("custom-bridge"), headers,
    payload: { version: created.json().source.updated_at, name: "修改后的桥接", route: "/baidu/tieba/forum/AI绘画", itemLimit: 20, aiFilter: false } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, id: "custom-bridge" });
  const settings = (await app.inject({ url: endpoint("custom-bridge"), headers })).json();
  assert.equal(settings.route, "/baidu/tieba/forum/AI绘画");
  assert.equal(settings.name, "修改后的桥接");
  assert.equal(settings.itemLimit, 20);
  assert.equal(settings.aiFilter, false);
  assert.equal(settings.origin, "custom");
  assert.notEqual(settings.version, created.json().source.updated_at);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=custom-bridge", headers })).json().rows[0];
  assert.equal(card.id, "custom-bridge");
  assert.equal(card.enabled, false);
  assert.equal(card.description, "人工简介");
  assert.equal(card.collectedCount, 0);
  assert.equal(card.lastCheckedAt, null);
  const detail = (await app.inject({ url: "/api/admin/sources/custom-bridge", headers })).json();
  assert.deepEqual(detail.source.config, { publisherRole: "organization" });
});

test("桥接只接受根相对路由，拒绝主机、查询凭据、片段、路径穿越及编码绕过，非法输入不修改来源", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "invalid-bridge", name: "路由校验", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  for (const route of ["https://evil.example/feed", "//evil.example/feed", "/feed?token=private", "/feed#private", "/../admin", "/a/./b", "/a/%2e%2e/admin", "/a/%252e%252e/admin", "/a\\admin", "/a/%2f/admin", "/a/%0d/admin"]) {
    const response = await app.inject({ method: "PUT", url: endpoint("invalid-bridge"), headers,
      payload: { version: created.json().source.updated_at, name: "不能保存", route, itemLimit: 15, aiFilter: true } });
    assert.equal(response.statusCode, 400, route);
  }
  const settings = (await app.inject({ url: endpoint("invalid-bridge"), headers })).json();
  assert.equal(settings.name, "路由校验");
  assert.equal(settings.origin, "missing");
  assert.equal(settings.route, null);
  assert.equal(settings.version, created.json().source.updated_at);
});

test("已移除来源不能读取或修改桥接设置，过期窗口不得覆盖新配置", async () => {
  const headers = await auth();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "lifecycle-bridge", name: "桥接生命周期", kind: "external", config: {} } });
  assert.equal(created.statusCode, 200);
  const payload = { version: created.json().source.updated_at, name: "桥接生命周期", route: "/qwen/blog", itemLimit: 8, aiFilter: false };
  assert.equal((await app.inject({ method: "PUT", url: endpoint("lifecycle-bridge"), headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: endpoint("lifecycle-bridge"), headers, payload: { ...payload, route: "/deepseek/changelog/zh" } })).statusCode, 409);
  const settings = (await app.inject({ url: endpoint("lifecycle-bridge"), headers })).json();
  assert.equal(settings.route, "/qwen/blog");
  const removed = await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/lifecycle-bridge/archive", headers,
    payload: { version: settings.version, archived: true } });
  assert.equal(removed.statusCode, 200);
  assert.equal((await app.inject({ url: endpoint("lifecycle-bridge"), headers })).statusCode, 409);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=lifecycle-bridge&archived=true", headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PUT", url: endpoint("lifecycle-bridge"), headers, payload: { ...payload, version: card.version } })).statusCode, 409);
});

test("桥接设置沿用登录及CSRF保护，拒绝不支持类型、未知来源、越界上限及多余字段", async () => {
  const headers = await auth();
  assert.equal((await app.inject({ url: endpoint("src-qwen-blog") })).statusCode, 401);
  const payload = { version: "2026-10-17T00:00:00.000Z", name: "无权覆盖", route: "/qwen/blog", itemLimit: 8, aiFilter: false };
  assert.equal((await app.inject({ method: "PUT", url: endpoint("src-qwen-blog"), headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  assert.equal((await app.inject({ url: endpoint("missing-bridge"), headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: endpoint("missing-bridge"), headers, payload })).statusCode, 404);
  const rss = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "wrong-kind-bridge", name: "RSS来源", kind: "rss", config: { feedUrl: "https://rss.example/feed" } } });
  assert.equal(rss.statusCode, 200);
  assert.equal((await app.inject({ url: endpoint("wrong-kind-bridge"), headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: endpoint("wrong-kind-bridge"), headers, payload })).statusCode, 404);
  for (const extra of [{ itemLimit: 0 }, { itemLimit: 51 }, { itemLimit: 1.5 }, { aiFilter: "true" }, { enabled: true }, { baseUrl: "http://169.254.169.254" }]) {
    assert.equal((await app.inject({ method: "PUT", url: endpoint("src-qwen-blog"), headers, payload: { ...payload, ...extra } })).statusCode, 400);
  }
  const read = await app.inject({ url: endpoint("src-qwen-blog"), headers });
  assert.ok(!read.body.includes("password") && !read.body.includes("token"));
});
