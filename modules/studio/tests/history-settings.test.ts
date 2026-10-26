import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture(), url = "/api/admin/studio/history-settings";
after(async () => { await app.close(); await closeDb(); });

test("历史召回数量设置私有读取、有限编辑及版本冲突保护，读取不创建版本", async () => {
  const initial = await app.inject({ url, headers }); assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["cache-control"], "no-store"); assert.deepEqual(initial.json(), { version: 0, candidateLimit: 50, evidenceLimit: 10 });
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.deepEqual((await app.inject({ url, headers })).json(), initial.json());
  const value = { version: 0, candidateLimit: 8, evidenceLimit: 3 };
  const saved = await app.inject({ method: "PUT", url, headers, payload: value }); assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { version: 1, candidateLimit: 8, evidenceLimit: 3 });
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: value })).statusCode, 409);
  for (const payload of [{ version: 1, candidateLimit: 0, evidenceLimit: 1 }, { version: 1, candidateLimit: 51, evidenceLimit: 1 },
    { version: 1, candidateLimit: 8, evidenceLimit: 9 }, { version: 1, candidateLimit: 50, evidenceLimit: 11 },
    { version: 1, candidateLimit: 8, evidenceLimit: 3, run: true }])
    assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 400);
  assert.deepEqual((await app.inject({ url, headers })).json(), saved.json());
});

test("网页独立保存历史数量，过期窗口不覆盖，重新载入仅改变本表单并保留未保存密钥与Cookie", async () => {
  const { chromium, expect } = await import("@playwright/test"), { createServer, request: forwardRequest } = await import("node:http");
  const { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { listenHttpForFetch } = await import("../../../tests/http-listener.ts");
  const origin = await listenHttpForFetch(app.server), api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", origin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    await page.goto(web.origin + "/admin/studio/settings/topics"); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "历史背景关联", exact: true });
    await expect(panel.getByLabel("历史候选上限（1–50）", { exact: true })).toHaveValue("8");
    await inSettingsSection(page, "models", () => page.getByLabel("API Key", { exact: true }).fill("unsaved-history-settings-key"));
    const cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true }); await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-history-settings-cookie"));
    const second = await context.newPage(); await second.goto(web.origin + "/admin/studio/settings/topics");
    const stale = second.getByRole("region", { name: "历史背景关联", exact: true });
    await panel.getByLabel("历史候选上限（1–50）", { exact: true }).fill("6"); await panel.getByLabel("完整背景证据上限（1–10）", { exact: true }).fill("2");
    await panel.getByRole("button", { name: "保存历史数量", exact: true }).click(); await expect(panel).toContainText("当前编辑版本 2");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("unsaved-history-settings-key"); await expect(cookie).toHaveValue("SUB=unsaved-history-settings-cookie");
    for (const [width, name] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/history-settings-${name}.png`, fullPage: true });
      await panel.screenshot({ path: `.impeccable/review/history-settings-section-${name}.png` });
    }
    await second.setViewportSize({ width: 390, height: 1100 }); await stale.getByLabel("历史候选上限（1–50）", { exact: true }).fill("5");
    await stale.getByRole("button", { name: "保存历史数量", exact: true }).click(); await expect(stale).toContainText("数量未保存，输入已保留");
    await expect(stale.getByLabel("历史候选上限（1–50）", { exact: true })).toHaveValue("5"); await expect(stale).toContainText("当前编辑版本 1");
    await stale.screenshot({ path: ".impeccable/review/history-settings-conflict-mobile.png" });
    second.on("dialog", dialog => dialog.accept()); await stale.getByRole("button", { name: "重新载入历史数量", exact: true }).click();
    await expect(stale.getByLabel("历史候选上限（1–50）", { exact: true })).toHaveValue("6"); await expect(stale).toContainText("当前编辑版本 2");
    await second.route("**/api/admin/studio/history-settings", route => route.fulfill({ status: 503, body: "unavailable" }));
    await stale.getByRole("button", { name: "重新载入历史数量", exact: true }).click(); await expect(stale).toContainText("最新数量暂时无法读取");
    await expect(stale.getByLabel("历史候选上限（1–50）", { exact: true })).toHaveValue("6");
    await stale.screenshot({ path: ".impeccable/review/history-settings-error-mobile.png" });
    await second.unroute("**/api/admin/studio/history-settings"); await stale.getByRole("button", { name: "重新载入历史数量", exact: true }).click();
    await expect(stale).toContainText("已载入最新数量");
    const saved = (await app.inject({ url, headers })).json(); assert.deepEqual(saved, { version: 2, candidateLimit: 6, evidenceLimit: 2 });
  } finally { await browser.close(); await web.stop(); }
});
