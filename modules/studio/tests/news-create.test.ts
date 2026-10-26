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
config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

async function session() {
  config.adminPassword = "studio-create-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-create-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("只填名称和RSS地址即可验证并保存，预览不收录材料，来源先暂停且不泄露配置", async () => {
  const headers = await session();
  transport.get("https://create.example").intercept({ path: "/rss?token=private-fixture" })
    .reply(200, '<rss version="2.0"><channel><title>影视日报</title><item><title>运镜更新</title><link>https://create.example/update</link></item></channel></rss>');
  const response = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "新增影视日报", kind: "rss", url: "https://create.example/rss?token=private-fixture", intervalMinutes: 30 } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().created, true);
  assert.ok(!response.body.includes("private-fixture"));
  const listing = await app.inject({ url: "/api/admin/studio/news-sources?q=" + encodeURIComponent("新增影视日报"), headers });
  assert.equal(listing.statusCode, 200);
  const card = listing.json().rows[0];
  assert.equal(card.id, response.json().id);
  assert.equal(card.enabled, false);
  assert.equal(card.collectedCount, 0);
  assert.equal(card.lastCheckedAt, null, "试读成功不是正式采集成功");
  assert.equal(card.validation.state, "ok");
  assert.equal(card.validation.itemCount, 1);
  assert.ok(card.validation.checkedAt);
  assert.ok(!listing.body.includes("private-fixture"));
});

test("重复添加已移除来源时找到原记录，不再次请求网站、覆盖名称或自动恢复", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "duplicate-news", name: "原有名称", kind: "rss", config: { feedUrl: "https://create.example/duplicate" } } });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/news-sources/duplicate-news/archive", headers,
    payload: { version: created.json().source.updated_at, archived: true } })).statusCode, 200);
  const response = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "不能覆盖旧名字", kind: "rss", url: "https://create.example/duplicate" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { created: false, id: "duplicate-news", archived: true });
  const listing = await app.inject({ url: "/api/admin/studio/news-sources?q=duplicate-news&archived=true", headers });
  assert.equal(listing.json().total, 1);
  assert.equal(listing.json().rows[0].name, "原有名称");
  assert.equal(listing.json().rows[0].enabled, false);
});

test("RSS暂时无法访问仍保留待处理来源，试读失败不冒充采集正常也不暴露错误正文", async () => {
  const headers = await session();
  transport.get("https://create.example").intercept({ path: "/unavailable?token=private-fixture" })
    .reply(503, "private-fixture upstream diagnostic");
  const response = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "等待来源恢复", kind: "rss", url: "https://create.example/unavailable?token=private-fixture" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().created, true);
  assert.ok(!response.body.includes("private-fixture"));
  const listing = await app.inject({ url: "/api/admin/studio/news-sources?q=" + response.json().id, headers });
  const card = listing.json().rows[0];
  assert.equal(card.validation.state, "failed");
  assert.equal(card.validation.itemCount, null);
  assert.equal(card.lastCheckedAt, null);
  assert.equal(card.enabled, false);
  assert.ok(!listing.body.includes("private-fixture"));
});

test("网页源先检查可访问性，没有提取规则时标需配置，明确规则后才报告试读条目", async () => {
  const headers = await session();
  const html = '<html><body><nav><a href="/about">关于</a></nav><article><h2>视频模型更新</h2><a href="/news/1">阅读</a></article></body></html>';
  for (const path of ["/web-basic", "/web-rules"]) transport.get("https://create.example").intercept({ path }).reply(200, html);
  for (const [path, rules, state, count] of [
    ["web-basic", {}, "needs_config", null],
    ["web-rules", { itemSelector: "article", linkSelector: "a", titleSelector: "h2" }, "ok", 1],
  ] as const) {
    const response = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
      payload: { name: path, kind: "web_list", url: `https://create.example/${path}`, config: rules } });
    assert.equal(response.statusCode, 200);
    const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + response.json().id, headers })).json().rows[0];
    assert.equal(card.enabled, false);
    assert.equal(card.validation.state, state);
    assert.equal(card.validation.itemCount, count);
    if (state === "needs_config") {
      assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/studio/news-sources/${card.id}/status`, headers,
        payload: { version: card.version, enabled: true } })).statusCode, 400);
      assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/sources/${card.id}`, headers,
        payload: { version: card.version, patch: { enabled: true } } })).statusCode, 400);
    }
  }
});

test("新增复用登录CSRF、输入校验和SSRF保护，不请求回环采集地址", async () => {
  const headers = await session();
  const payload = { name: "权限与地址校验", kind: "rss", url: "https://create.example/not-requested" };
  const post = (data: Record<string, unknown>, authorization = headers) => app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers: authorization, payload: data });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  for (const url of ["not-a-url-private-fixture", "file:///private", "javascript:alert(1)", "https://user:private-fixture@create.example"]) {
    const rejected = await post({ ...payload, url });
    assert.equal(rejected.statusCode, 400);
    assert.ok(!rejected.body.includes("private-fixture"));
  }
  assert.equal((await post({ ...payload, intervalMinutes: 0 })).statusCode, 400);
  const previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = false;
  try {
    const result = await post({ ...payload, url: "http://127.0.0.1:9000/feed" });
    assert.equal(result.statusCode, 200);
    const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + result.json().id, headers })).json().rows[0];
    assert.equal(card.validation.state, "failed");
    assert.equal(card.enabled, false);
  } finally { config.allowPrivateNetworkFetch = previousPrivate; }
});

test("同时提交相同地址也只创建一个来源，后续改采集配置会让旧试读状态失效", async () => {
  const headers = await session();
  transport.get("https://create.example").intercept({ path: "/race" })
    .reply(200, '<rss version="2.0"><channel><title>并发试读</title></channel></rss>').times(2);
  const responses = await Promise.all(["窗口一", "窗口二"].map(name => app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name, kind: "rss", url: "https://create.example/race" } })));
  for (const response of responses) assert.equal(response.statusCode, 200);
  assert.equal(responses.filter(response => response.json().created).length, 1);
  const id = responses[0].json().id;
  assert.equal(responses[1].json().id, id);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  assert.equal(card.validation.state, "ok");
  const changed = await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
    payload: { version: card.version, patch: { config: { feedUrl: "https://create.example/changed" } } } });
  assert.equal(changed.statusCode, 200);
  const next = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  assert.equal(next.validation, null);
});

test("在工作台读取和修改已有采集设置，重新试读后暂停，旧窗口不能覆盖", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "settings-news", name: "待修改来源", kind: "rss", config: { feedUrl: "https://create.example/original" } } });
  assert.equal(created.statusCode, 200);
  const endpoint = "/api/admin/studio/news-sources/settings-news/configuration";
  assert.equal((await app.inject({ url: endpoint })).statusCode, 401);
  const settings = await app.inject({ url: endpoint, headers });
  assert.equal(settings.statusCode, 200);
  assert.equal(settings.headers["cache-control"], "no-store");
  assert.equal(settings.json().url, "https://create.example/original");
  transport.get("https://create.example").intercept({ path: "/new-feed?token=private-fixture" })
    .reply(200, '<rss version="2.0"><channel><title>修改的来源</title></channel></rss>');
  const payload = { version: settings.json().version, name: "修改的来源", kind: "rss", url: "https://create.example/new-feed?token=private-fixture", intervalMinutes: 60, config: {} };
  const changed = await app.inject({ method: "PUT", url: endpoint, headers, payload });
  assert.equal(changed.statusCode, 200);
  assert.ok(!changed.body.includes("private-fixture"));
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=settings-news", headers })).json().rows[0];
  assert.equal(card.name, "修改的来源");
  assert.equal(card.enabled, false);
  assert.equal(card.validation.state, "ok");
  assert.equal(card.validation.itemCount, 0);
  assert.equal((await app.inject({ method: "PUT", url: endpoint, headers, payload })).statusCode, 409);
  const current = (await app.inject({ url: endpoint, headers })).json();
  assert.equal(current.intervalMinutes, 60);
  assert.equal(current.url, payload.url);
});

test("原来源改换采集地址后，可以重新添加旧地址，两个来源身份独立", async () => {
  const headers = await session();
  transport.get("https://create.example").intercept({ path: "/readd-origin" })
    .reply(200, '<rss version="2.0"><channel><title>原地址</title></channel></rss>').times(2);
  const payload = { name: "最初来源", kind: "rss", url: "https://create.example/readd-origin" };
  const first = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers, payload });
  assert.equal(first.statusCode, 200);
  const id = first.json().id;
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
    payload: { version: card.version, patch: { config: { feedUrl: "https://create.example/moved-away" } } } })).statusCode, 200);
  const second = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers, payload: { ...payload, name: "重新关注旧地址" } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().created, true);
  assert.notEqual(second.json().id, id);
});

test("旧入口修改网页地址使试读过期后，仍不能启用缺少规则的来源", async () => {
  const headers = await session();
  transport.get("https://create.example").intercept({ path: "/rules-expire" })
    .reply(200, '<article><a href="/news/2">创作更新</a></article>');
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "规则不能被绕过", kind: "web_list", url: "https://create.example/rules-expire", config: { itemSelector: "article" } } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  const changed = await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
    payload: { version: (await read()).version, patch: { config: { url: "https://create.example/changed-without-rules" } } } });
  assert.equal(changed.statusCode, 200);
  const card = await read();
  assert.equal(card.validation, null, "旧试读不再适用于新配置");
  const enabled = await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
    payload: { version: card.version, patch: { enabled: true } } });
  assert.equal(enabled.statusCode, 400);
  assert.equal((await read()).enabled, false);
});

test("启用和修改同时提交时检查新规则，已启用来源也不能删掉规则后继续采集", async () => {
  const headers = await session();
  const url = "https://create.example/rules-next";
  transport.get("https://create.example").intercept({ path: "/rules-next" })
    .reply(200, '<article><a href="/news/3">制作流程</a></article>');
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "检查生效配置", kind: "web_list", url, config: { itemSelector: "article" } } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
  const patch = async (changes: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, headers,
    payload: { version: (await read()).version, patch: changes } });
  assert.equal((await patch({ enabled: true, config: { url } })).statusCode, 400);
  assert.equal((await read()).enabled, false);
  assert.equal((await patch({ enabled: true, config: { url, itemSelector: "article" } })).statusCode, 200);
  assert.equal((await patch({ config: { url } })).statusCode, 400);
  const settings = (await app.inject({ url: `/api/admin/studio/news-sources/${id}/configuration`, headers })).json();
  assert.equal(settings.config.itemSelector, "article", "拒绝修改时保留原本可用配置");
});
