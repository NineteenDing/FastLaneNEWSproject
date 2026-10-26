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
import { createImageAssets } from "../backend/image-assets.ts";

installModules(SERVER_MODULES);
const app = await buildApp();
const previous = getGlobalDispatcher();
const transport = new MockAgent();
transport.disableNetConnect();
setGlobalDispatcher(transport);
config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

async function session() {
  config.adminPassword = "studio-metadata-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-metadata-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}

test("从RSS声明的实际主页补全资料和图标，头像本地登录后读取，不把RSSHub当来源主页或泄露图标地址", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "metadata-rss", name: "影视来源", kind: "rss", config: { feedUrl: "https://feed-relay.example/rss?token=private-fixture" } } });
  assert.equal(created.statusCode, 200);
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-rss", headers })).json().rows[0];
  const before = await read();
  transport.get("https://feed-relay.example").intercept({ path: "/rss?token=private-fixture" })
    .reply(200, '<rss version="2.0"><channel><title>来源</title><link>https://publisher.example/news</link><description>影视制作与工具新闻</description><language>zh-CN</language></channel></rss>');
  transport.get("https://publisher.example").intercept({ path: "/news" })
    .reply(200, '<html lang="zh-CN"><head><meta name="description" content="来源网站简介"><link rel="icon" href="/icon.svg?token=private-fixture"></head></html>');
  transport.get("https://publisher.example").intercept({ path: "/icon.svg?token=private-fixture" })
    .reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#216560"/></svg>', { headers: { "content-type": "image/svg+xml" } });
  const refreshed = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-rss/refresh-profile", headers,
    payload: { version: before.version, profileVersion: before.profileVersion } });
  assert.equal(refreshed.statusCode, 200);
  assert.ok(!refreshed.body.includes("private-fixture"));
  const card = await read();
  assert.equal(card.description, "影视制作与工具新闻");
  assert.equal(card.homepage, "https://publisher.example/news");
  assert.equal(card.language, "zh-CN");
  assert.equal(card.region, null, "不从服务器或网站语言猜服务地区");
  assert.equal(card.lastCheckedAt, null, "资料读取不是新闻采集成功");
  assert.equal(card.metadata.state, "ok");
  assert.match(card.avatarUrl, /^\/api\/admin\/studio\/news-sources\/metadata-rss\/avatar\?v=[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(card).includes("private-fixture"));
  assert.equal((await app.inject({ url: card.avatarUrl })).statusCode, 401);
  for (let n = 0; n < 2; n++) {
    const avatar = await app.inject({ url: card.avatarUrl, headers });
    assert.equal(avatar.statusCode, 200);
    assert.equal(avatar.headers["content-type"], "image/webp");
    assert.equal(avatar.headers["cache-control"], "no-store");
    assert.ok(avatar.rawPayload.length > 0);
  }
});

test("手写资料和主动清空的字段不被自动补全覆盖", async () => {
  const headers = await session();
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-rss", headers })).json().rows[0];
  const before = await read();
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/metadata-rss/profile", headers,
    payload: { version: before.profileVersion, description: "我手写的来源简介", region: "中国", language: null, homepage: null } })).statusCode, 200);
  const edited = await read();
  assert.equal(edited.description, "我手写的来源简介");
  assert.equal(edited.language, null);
  assert.equal(edited.homepage, null, "清空自动取得的主页后不立即回填");
  transport.get("https://feed-relay.example").intercept({ path: "/rss?token=private-fixture" })
    .reply(200, '<rss><channel><link>https://publisher.example/news</link><description>网站改变后的简介</description><language>en</language></channel></rss>');
  transport.get("https://publisher.example").intercept({ path: "/news" }).reply(200, '<html lang="en"><head></head></html>');
  transport.get("https://publisher.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-rss/refresh-profile", headers,
    payload: { version: edited.version, profileVersion: edited.profileVersion } })).statusCode, 200);
  const next = await read();
  assert.equal(next.description, "我手写的来源简介");
  assert.equal(next.region, "中国");
  assert.equal(next.language, null);
  assert.equal(next.homepage, null);
});

test("自动资料改变后旧编辑窗口不能把旧值保存回来", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "metadata-version", name: "自动资料版本", kind: "web_list", config: { url: "https://version.example/news", itemSelector: "article" } } });
  assert.equal(created.statusCode, 200);
  const before = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-version", headers })).json().rows[0];
  transport.get("https://version.example").intercept({ path: "/news" }).reply(200, '<html lang="zh-CN"><meta name="description" content="刚刚取得的资料"></html>');
  transport.get("https://version.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-version/refresh-profile", headers,
    payload: { version: before.version, profileVersion: before.profileVersion } })).statusCode, 200);
  const stale = await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/metadata-version/profile", headers,
    payload: { version: before.profileVersion, description: null, region: null, language: null, homepage: null } });
  assert.equal(stale.statusCode, 409);
  const after = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-version", headers })).json().rows[0];
  assert.equal(after.description, "刚刚取得的资料");
  assert.ok(after.profileVersion > before.profileVersion);
});

test("资料刷新暂时失败时标记失败但保留同一配置下已取得的可靠资料", async () => {
  const headers = await session();
  const before = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-version", headers })).json().rows[0];
  transport.get("https://version.example").intercept({ path: "/news" }).reply(503, "private-fixture diagnostic");
  const refreshed = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-version/refresh-profile", headers,
    payload: { version: before.version, profileVersion: before.profileVersion } });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().state, "failed");
  assert.ok(!refreshed.body.includes("private-fixture"));
  const after = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-version", headers })).json().rows[0];
  assert.equal(after.description, "刚刚取得的资料");
  assert.equal(after.metadata.state, "failed");
  assert.equal(after.lastCheckedAt, null);
});

test("补全需登录CSRF和当前版本，缺主页如实提示，私网和超大响应不成为正常资料", async () => {
  const headers = await session();
  const endpoint = "/api/admin/studio/news-sources/metadata-rss/refresh-profile";
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-rss", headers })).json().rows[0];
  const payload = { version: card.version, profileVersion: card.profileVersion };
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, profileVersion: -1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, version: "2000-01-01T00:00:00.000Z" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: endpoint.replace("metadata-rss", "unknown-source"), headers, payload })).statusCode, 404);
  for (const [id, kind, url, expected] of [
    ["metadata-no-home", "external", null, "needs_homepage"],
    ["metadata-private", "web_list", "http://169.254.169.254/latest/meta-data/", "failed"],
    ["metadata-oversize", "web_list", "https://limits.example/large", "failed"],
  ] as const) {
    const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id, name: id, kind, config: url ? { url, itemSelector: "article" } : {} } });
    assert.equal(created.statusCode, 200);
    if (id === "metadata-oversize") transport.get("https://limits.example").intercept({ path: "/large" }).reply(200, "x".repeat(2 * 1024 * 1024 + 1));
    const allowPrivate = config.allowPrivateNetworkFetch;
    if (id === "metadata-private") config.allowPrivateNetworkFetch = false;
    try {
      const result = await app.inject({ method: "POST", url: `/api/admin/studio/news-sources/${id}/refresh-profile`, headers,
        payload: { version: created.json().source.updated_at, profileVersion: 0 } });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().state, expected);
      const next = (await app.inject({ url: "/api/admin/studio/news-sources?q=" + id, headers })).json().rows[0];
      assert.equal(next.avatarUrl, null);
      assert.equal(next.homepage, null);
      assert.equal(next.description, null);
    } finally { config.allowPrivateNetworkFetch = allowPrivate; }
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/news-sources/unknown-source/avatar", headers })).statusCode, 404);
});

test("主页正常但图标暂时故障时保留旧头像，并明确标注头像失败", async () => {
  const headers = await session();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "metadata-icon-keep", name: "头像故障保留", kind: "web_list", config: { url: "https://icon-keep.example/news", itemSelector: "article" } } })).statusCode, 200);
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-icon-keep", headers })).json().rows[0];
  const refresh = async () => { const card = await read(); return app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-icon-keep/refresh-profile", headers,
    payload: { version: card.version, profileVersion: card.profileVersion } }); };
  transport.get("https://icon-keep.example").intercept({ path: "/news" })
    .reply(200, '<html><link rel="icon" href="/icon.svg"><meta name="description" content="正常主页"></html>').times(2);
  transport.get("https://icon-keep.example").intercept({ path: "/icon.svg" })
    .reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>', { headers: { "content-type": "image/svg+xml" } });
  transport.get("https://icon-keep.example").intercept({ path: "/icon.svg" }).reply(503, "unavailable");
  transport.get("https://icon-keep.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
  assert.equal((await refresh()).statusCode, 200);
  const first = await read();
  assert.ok(first.avatarUrl);
  const failed = await refresh();
  assert.equal(failed.statusCode, 200);
  const next = await read();
  assert.equal(next.avatarUrl, first.avatarUrl);
  assert.equal(next.metadata.iconState, "failed");
  assert.equal(failed.json().hasIcon, true);
  assert.equal((await app.inject({ url: next.avatarUrl, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/sources/metadata-icon-keep", headers,
    payload: { version: next.version, patch: { config: { url: "https://icon-keep.example/changed", itemSelector: "article" } } } })).statusCode, 200);
  const changed = await read();
  assert.equal(changed.metadata, null);
  assert.equal(changed.avatarUrl, null);
  assert.equal(changed.description, null);
  assert.equal((await app.inject({ url: next.avatarUrl, headers })).statusCode, 404, "旧来源配置的头像不能当成新配置的当前头像");
});

test("补全期间发生人工编辑时拒绝迟到结果，不覆盖新资料", async () => {
  const headers = await session();
  const created = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "metadata-race", name: "资料并发保护", kind: "web_list", config: { url: "https://metadata-race.example/news", itemSelector: "article" } } });
  assert.equal(created.statusCode, 200);
  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  transport.get("https://metadata-race.example").intercept({ path: "/news" }).reply(() => {
    announce(); return { statusCode: 200, data: '<html><meta name="description" content="迟到的自动简介"></html>' };
  }).delay(200);
  transport.get("https://metadata-race.example").intercept({ path: "/favicon.ico" }).reply(404, "missing");
  const refresh = app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-race/refresh-profile", headers,
    payload: { version: created.json().source.updated_at, profileVersion: 0 } });
  await started;
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/news-sources/metadata-race/profile", headers,
    payload: { version: 0, description: "刚保存的人工简介", region: null, language: null, homepage: null } })).statusCode, 200);
  assert.equal((await refresh).statusCode, 409);
  const card = (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-race", headers })).json().rows[0];
  assert.equal(card.description, "刚保存的人工简介");
  assert.equal(card.metadata, null);
});

test("实际头像保存进入长期素材池，更换头像不清理仍被其他记录引用的旧图", async () => {
  const headers = await session();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "metadata-image-pool", name: "长期头像素材", kind: "web_list", config: { url: "https://image-pool.example/news", itemSelector: "article" } } })).statusCode, 200);
  const read = async () => (await app.inject({ url: "/api/admin/studio/news-sources?q=metadata-image-pool", headers })).json().rows[0];
  const refresh = async (color: string) => {
    transport.get("https://image-pool.example").intercept({ path: "/news" }).reply(200, '<html><link rel="icon" href="/icon.svg"></html>');
    transport.get("https://image-pool.example").intercept({ path: "/icon.svg" })
      .reply(200, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`, { headers: { "content-type": "image/svg+xml" } });
    const card = await read();
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/news-sources/metadata-image-pool/refresh-profile", headers,
      payload: { version: card.version, profileVersion: card.profileVersion } })).statusCode, 200);
    return read();
  };
  const images = createImageAssets();
  const first = await refresh("#19abaa");
  const oldId = new URL(first.avatarUrl, "http://local").searchParams.get("v")!;
  const avatar = await app.inject({ url: first.avatarUrl, headers });
  assert.equal(avatar.statusCode, 200);
  assert.deepEqual(await images.read(oldId), { body: avatar.rawPayload, type: "image/webp" });
  await images.setReferences("snapshot:avatar-fixture", [oldId]);
  try {
    const current = await refresh("#95be35");
    assert.notEqual(current.avatarUrl, first.avatarUrl);
    await images.prune(new Date(Date.now() + 60_000));
    assert.ok(await images.read(oldId));
    assert.equal((await app.inject({ url: current.avatarUrl, headers })).statusCode, 200);
    await images.setReferences("snapshot:avatar-fixture", []);
    await images.prune(new Date(Date.now() + 60_000));
    assert.equal(await images.read(oldId), null);
    assert.equal((await app.inject({ url: current.avatarUrl, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: current.avatarUrl })).statusCode, 401);
  } finally { await images.setReferences("snapshot:avatar-fixture", []); }
});
