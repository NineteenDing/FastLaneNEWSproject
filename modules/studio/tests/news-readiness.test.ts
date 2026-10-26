import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
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
after(async () => { setGlobalDispatcher(previous); await transport.close(); await app.close(); await stopBoss(); await closeDb(); });

test("缺规则网页的已排队强制任务不访问网站或收录导航，立即采集入口也明确拒绝", async () => {
  config.adminPassword = "studio-readiness-test-password";
  const signed = await app.inject({ method: "POST", url: "/api/auth/password",
    headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=studio-readiness-test-password&return=/admin" });
  assert.equal(signed.statusCode, 303);
  const cookie = String(signed.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  const headers = { cookie, "x-csrf-token": me.json().csrf };
  let requests = 0;
  transport.get("https://readiness.example").intercept({ path: "/news" }).reply(() => {
    requests += 1;
    return { statusCode: 200, data: '<html><a href="/about">关于我们</a><a href="/contact">联系我们</a></html>' };
  }).persist();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/news-sources", headers,
    payload: { name: "尚无提取规则", kind: "web_list", url: "https://readiness.example/news" } });
  assert.equal(created.statusCode, 200);
  assert.equal(requests, 1, "允许新增时有界检查可访问性");
  requests = 0;
  const id = created.json().id;
  const result = await collectSource(id, { force: true });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /提取规则/);
  assert.equal(requests, 0, "强制任务在实际请求前检查规则");
  const detail = await app.inject({ url: `/api/admin/sources/${id}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items.length, 0);
  assert.equal(detail.json().runs[0].status, "failed");
  const manual = await app.inject({ method: "POST", url: `/api/admin/sources/${id}/fetch`, headers });
  assert.equal(manual.statusCode, 400);
  assert.equal(requests, 0);
});
