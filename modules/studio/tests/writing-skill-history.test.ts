import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import type { WritingSkillVersionPage } from "../contracts.ts";
import { config } from "@aihot/backend/config";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";

const { app, headers } = await sourceResourceFixture();
const endpoint = "/api/admin/studio/writing-skills";
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("私有写作Skill历史按版本分页阅读，后续修改不替换旧规则，内置Humanizer初版仍可查", async () => {
  const created = await app.inject({ method: "POST", url: endpoint, headers,
    payload: { name: "实操规则初版", body: "先给出条件，再说明操作。", columnIds: ["practice"], enabled: false, priority: 25 } });
  assert.equal(created.statusCode, 200); const skill = created.json(), history = `${endpoint}/${skill.id}/versions`;
  assert.equal((await app.inject({ url: history })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url: `${endpoint}/${skill.id}`, headers,
    payload: { version: 1, name: "修改后的规则", body: "先说明制作问题，保留限制。", enabled: true } })).statusCode, 200);
  const response = await app.inject({ url: history + "?limit=1", headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const first = response.json<WritingSkillVersionPage>();
  assert.deepEqual({ ...first, rows: first.rows.map(row => ({ version: row.version, name: row.name })) },
    { rows: [{ version: 2, name: "修改后的规则" }], total: 2, page: 1, hasMore: true, currentVersion: 2 });
  const second = (await app.inject({ url: history + "?limit=1&page=2", headers })).json();
  assert.equal(second.hasMore, false); assert.equal(second.rows[0].body, "先给出条件，再说明操作。");
  assert.equal(second.rows[0].enabled, false); assert.equal(second.rows[0].priority, 25);
  assert.deepEqual(second.rows[0].columnIds, ["practice"]);
  const original = await app.inject({ url: history + "/1", headers });
  assert.equal(original.statusCode, 200); assert.deepEqual(original.json(), skill);
  assert.equal((await app.inject({ url: history + "/99", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `${endpoint}/${randomUUID()}/versions`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: history + "?limit=31", headers })).statusCode, 400);
  const builtin = (await app.inject({ url: endpoint + "/humanizer-zh/versions", headers })).json();
  assert.equal(builtin.total, 1); assert.equal(builtin.rows[0].version, 1);
  assert.ok(builtin.rows[0].body.includes("保留信息和确定程度"));
});

test("回退Skill追加新版本并恢复旧配置，过期窗口不能覆盖，内置Humanizer也能恢复原规则", async () => {
  const original = { name: "教程规则", body: "不要虚构亲测，先说适用条件。", columnIds: ["practice"], enabled: false, priority: 30 };
  const skill = (await app.inject({ method: "POST", url: endpoint, headers, payload: original })).json();
  const url = `${endpoint}/${skill.id}`;
  assert.equal((await app.inject({ method: "PATCH", url, headers,
    payload: { version: 1, body: "修改后的规则", name: "新版", enabled: true, priority: 10, columnIds: ["models"] } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: url + "/restore", payload: { version: 2, sourceVersion: 1 } })).statusCode, 401);
  const restored = await app.inject({ method: "POST", url: url + "/restore", headers, payload: { version: 2, sourceVersion: 1 } });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().version, 3);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(restored.json()[key], value);
  assert.equal((await app.inject({ url: url + "/versions/2", headers })).json().body, "修改后的规则");
  assert.equal((await app.inject({ url: url + "/versions/1", headers })).json().body, original.body);
  assert.equal((await app.inject({ method: "POST", url: url + "/restore", headers, payload: { version: 2, sourceVersion: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: url + "/restore", headers, payload: { version: 3, sourceVersion: 99 } })).statusCode, 404);
  assert.equal((await app.inject({ url: url + "/versions", headers })).json().total, 3);
  const builtinUrl = endpoint + "/humanizer-zh", baseline = (await app.inject({ url: builtinUrl + "/versions/1", headers })).json();
  assert.equal((await app.inject({ method: "PATCH", url: builtinUrl, headers, payload: { version: 1, body: "临时替换的中文规则", enabled: false } })).statusCode, 200);
  const reset = await app.inject({ method: "POST", url: builtinUrl + "/restore", headers, payload: { version: 2, sourceVersion: 1 } });
  assert.equal(reset.statusCode, 200); assert.equal(reset.json().version, 3); assert.equal(reset.json().body, baseline.body); assert.equal(reset.json().enabled, true);
  const history = (await app.inject({ url: builtinUrl + "/versions?limit=1&page=3", headers })).json();
  assert.equal(history.total, 3); assert.equal(history.rows[0].version, 1); assert.equal(history.hasMore, false);
});

test("网页按需阅读Skill旧版本并确认回退，局部错误不丢设置，旧窗口识别版本冲突", async () => {
  await mkdir(".impeccable/review", { recursive: true });
  const name = "历史阅读测试", original = "先明确制作问题，再演示操作。资料尚未亲测，保留适用条件。";
  const skill = (await app.inject({ method: "POST", url: endpoint, headers,
    payload: { name, body: original, enabled: false, columnIds: ["practice"], priority: 40 } })).json();
  for (let version = 1; version < 12; version++) assert.equal((await app.inject({ method: "PATCH", url: `${endpoint}/${skill.id}`, headers,
    payload: { version, body: `第${version + 1}版：先展示两个镜头的问题，再说明参考图的条件与操作。`, enabled: true } })).statusCode, 200);
  const web = await startWebServer(app.server), browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), page = await context.newPage();
  const target = (p: typeof page) => p.locator(".studio-skill-list > details").filter({ has: p.getByText(name, { exact: true }) });
  try {
    let reads = 0; page.on("request", request => { if (request.url().includes(`/writing-skills/${skill.id}/versions?`)) reads++; });
    await page.goto(web.origin + "/admin/studio/settings/skills");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await target(page).locator(":scope > summary").click();
    const history = page.getByRole("group", { name: name + "的历史版本", exact: true });
    assert.equal(await history.getAttribute("open"), null); assert.equal(reads, 0);
    const key = page.getByLabel("API Key", { exact: true }), cookie = page.getByRole("region", { name: "微博登录设置", exact: true, includeHidden: true }).getByLabel("登录信息（Cookie）", { exact: true });
    await inSettingsSection(page, "models", () => key.fill("unsaved-history-key")); await inSettingsSection(page, "platforms", () => cookie.fill("SUB=unsaved-history-cookie"));
    await history.locator(":scope > summary").click(); await history.getByRole("button", { name: "下一页版本", exact: true }).click();
    const first = history.locator(".studio-language-samples > details").filter({ has: page.getByText(`版本 1 · ${name}`, { exact: true }) });
    await first.locator(":scope > summary").click(); await expect(first).toContainText(original);
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1100 }); await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/skill-history-${suffix}.png`, fullPage: true });
      await history.screenshot({ path: `.impeccable/review/skill-history-section-${suffix}.png` });
    }
    await page.route("**/writing-skills/*/versions?*", route => route.fulfill({ status: 503, body: "unavailable" }));
    await history.getByRole("button", { name: "上一页版本", exact: true }).click();
    await expect(history.getByRole("alert")).toContainText("历史版本暂时无法读取");
    await expect(key).toHaveValue("unsaved-history-key"); await expect(cookie).toHaveValue("SUB=unsaved-history-cookie");
    await history.screenshot({ path: ".impeccable/review/skill-history-error-mobile.png" });
    await page.unroute("**/writing-skills/*/versions?*"); await history.getByRole("button", { name: "重试读取历史", exact: true }).click();
    await expect(history.getByRole("alert")).toHaveCount(0); await history.getByRole("button", { name: "下一页版本", exact: true }).click(); await first.locator(":scope > summary").click();
    const stale = await context.newPage(); await stale.goto(web.origin + "/admin/studio/settings/skills");
    await target(page).getByLabel("写作规则", { exact: true }).fill("此规则尚未保存的修改");
    page.once("dialog", async dialog => { assert.ok(dialog.message().includes("丢弃此规则尚未保存的编辑")); assert.ok(dialog.message().includes("停用")); await dialog.accept(); });
    await first.getByRole("button", { name: "恢复为版本 1", exact: true }).click();
    await expect(target(page).locator(":scope > summary")).toContainText("版本 13 · 已停用");
    await expect(key).toHaveValue("unsaved-history-key"); await expect(cookie).toHaveValue("SUB=unsaved-history-cookie");
    const restored = (await app.inject({ url: `${endpoint}/${skill.id}/versions/13`, headers })).json();
    assert.equal(restored.body, original); assert.equal(restored.enabled, false);
    await target(stale).locator(":scope > summary").click();
    const old = stale.getByRole("group", { name: name + "的历史版本", exact: true }); await old.locator(":scope > summary").click();
    await expect(old.getByRole("alert")).toContainText("此规则已在其他窗口更新");
    await old.locator(".studio-language-samples > details").filter({ has: stale.getByText(`版本 12 · ${name}`, { exact: true }) }).locator("summary").click();
    await expect(old.getByRole("button", { name: "恢复为版本 12", exact: true })).toBeDisabled();
    await stale.close();
  } finally { await context.close(); await browser.close(); await web.stop(); }
});
