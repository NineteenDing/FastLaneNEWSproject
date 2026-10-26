import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
const password = "source-resource-password";
async function login(username?: string, value = password) {
  const payload = new URLSearchParams({ password: value, return: "/admin/studio/following" });
  if (username !== undefined) payload.set("username", username);
  return app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: payload.toString() });
}

test("工作台用户名由服务端校验，缺失或错误用户名不能凭正确密码建立会话", async () => {
  for (const name of [undefined, "someone-else"]) {
    const rejected = await login(name);
    assert.equal(rejected.statusCode, 303); assert.ok(rejected.headers.location?.includes("error=wrong"));
    assert.equal(rejected.headers["set-cookie"], undefined);
  }
  const wrongPassword = await login("admin", "wrong-password");
  assert.ok(wrongPassword.headers.location?.includes("error=wrong")); assert.equal(wrongPassword.headers["set-cookie"], undefined);
  const accepted = await login("admin"); assert.equal(accepted.statusCode, 303);
  assert.equal(accepted.headers.location, "/admin/studio/following");
  const cookie = String(accepted.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  assert.equal(me.statusCode, 200); assert.equal(me.headers["cache-control"], "no-store"); assert.ok(me.json().csrf);
  assert.equal((await app.inject({ url: "/api/auth/options" })).json().username, true);
});

test("修改管理员用户名立即撤销旧身份会话，恢复旧用户名不会复活已撤销会话", async () => {
  const accepted = await login("admin"), cookie = String(accepted.headers["set-cookie"]).split(";")[0];
  const original = config.adminUsername;
  try {
    config.adminUsername = "film-editor";
    assert.equal((await app.inject({ url: "/api/admin/me", headers: { cookie } })).statusCode, 401);
    assert.equal((await login("admin")).headers["set-cookie"], undefined);
    const current = await login("film-editor");
    assert.equal(current.headers.location, "/admin/studio/following");
    const currentCookie = String(current.headers["set-cookie"]).split(";")[0];
    assert.equal((await app.inject({ url: "/api/admin/me", headers: { cookie: currentCookie } })).statusCode, 200);
  } finally { config.adminUsername = original; }
  assert.equal((await app.inject({ url: "/api/admin/me", headers: { cookie } })).statusCode, 401);
});

test("实际登录页同时提交用户名密码，错误可恢复，窄屏不溢出且登录退出保留服务端保护", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { mkdir } = await import("node:fs/promises"); await mkdir(".impeccable/review", { recursive: true });
  const web = await startWebServer(app.server, { STUDIO_PRIVATE_ENTRY: "true" }), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const home = await page.goto(web.origin + "/"); assert.equal(home?.status(), 200);
    assert.match(home!.headers()["cache-control"]!, /no-cache|no-store/);
    assert.equal(home!.headers()["x-accel-expires"], "0", "公开API的即时许可必须传递到实际SSR页面缓存");
    await expect(page).toHaveURL(web.origin + "/"); await expect(page.getByRole("link", { name: "工作台登录", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(nav.getByRole("link", { name: "全部 AI影视动态", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "AI影视日报", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "AI影视热点榜", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "主题", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Agent 接入", exact: true })).toHaveCount(0);
    const links = await nav.locator('a').allTextContents();
    assert.equal(links[links.indexOf("AI影视日报") + 1], "收藏", "隐藏主题后日报与收藏相邻");
    for (const path of ["/topics", "/topics/example", "/topics/example/page/2", "/agent"]) {
      assert.equal((await page.request.get(web.origin + path)).status(), 404, `暂停页面仍保留代码但不启用：${path}`);
    }
    for (const path of ["/sitemap.xml", "/llms.txt"]) {
      const discovery = await page.request.get(web.origin + path); assert.equal(discovery.status(), 200);
      const body = await discovery.text();
      assert.ok(!body.includes(`${web.origin}/topics`) && !body.includes(`${web.origin}/agent`), "发现入口不指向暂停的网页");
    }
    await page.goto(web.origin + "/more");
    await expect(page.getByRole("link", { name: "主题", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Agent 接入", exact: false })).toHaveCount(0);
    await page.goto(web.origin + "/");
    await page.getByRole("link", { name: "工作台登录", exact: true }).click();
    await expect(page.getByLabel("管理员用户名", { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).pathname, "/admin/login");
    const target = new URL(page.url()).searchParams.get("return")!;
    assert.ok(!target.includes(".data") && !target.includes("_routes"), "登录返回地址必须是页面而非路由数据请求");
    await page.goto(web.origin + "/admin/login?return=%2Fadmin%2Fstudio%2Ffollowing");
    await expect(page.getByLabel("管理员用户名", { exact: true })).toHaveValue("admin");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/phase2-admin-username-${width}.png`, fullPage: true });
    }
    await page.getByLabel("管理员用户名", { exact: true }).fill("wrong-user"); await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("用户名或密码不对");
    await page.getByLabel("管理员用户名", { exact: true }).fill("admin"); await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).toHaveURL(/\/admin\/studio\/following/);
    const forbidden = await page.request.put(web.origin + "/api/admin/studio/filter-settings", { data: {} }); assert.equal(forbidden.status(), 403);
    await page.request.post(web.origin + "/api/auth/logout");
    assert.equal((await page.request.get(web.origin + "/api/admin/me")).status(), 401);
    await page.goto(web.origin + "/"); await expect(page).toHaveURL(web.origin + "/");
  } finally { await browser.close(); await web.stop(); }
});
