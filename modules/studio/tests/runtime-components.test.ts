import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { config } from "@aihot/backend/config";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
test("组件文件检查需要登录、不公开路径和密钥，缺失的操作员路径不假称已就绪", async t => {
  const variables = ["STUDIO_ASR_PYTHON", "STUDIO_MEDIACRAWLER_PYTHON", "STUDIO_RSSHUB_BASE_URL", "STUDIO_RSSHUB_NATIVE_DIRECTORY"];
  const before = variables.map(key => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.STUDIO_ASR_PYTHON = join(config.dataDir, "missing-asr-python.exe");
  process.env.STUDIO_MEDIACRAWLER_PYTHON = join(config.dataDir, "missing-crawler-python.exe");
  delete process.env.STUDIO_RSSHUB_BASE_URL; delete process.env.STUDIO_RSSHUB_NATIVE_DIRECTORY;
  const url = "/api/admin/studio/runtime-components";
  assert.equal((await app.inject({ url })).statusCode, 401);
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const result = response.json(); assert.equal(result.check, "local_files"); assert.equal(result.rows.length, 4);
  for (const id of ["mediacrawler", "asr"]) assert.equal(result.rows.find((row: {id: string}) => row.id === id).state, "missing");
  assert.equal(result.rows.find((row: {id: string}) => row.id === "rsshub").state, "not_configured");
  assert.ok(!response.body.includes(config.dataDir)); assert.ok(!response.body.includes("missing-asr-python.exe")); assert.ok(!response.body.includes(config.adminPassword!));
});

test("设置中的组件检查按需读取且保留未保存Key，桌面和窄屏可读", async () => {
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); let calls = 0;
    page.on("request", request => { if (request.url().includes("/api/admin/studio/runtime-components")) calls++; });
    await page.goto(web.origin + "/admin/studio/settings/collection"); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible(); assert.equal(calls, 0);
    await inSettingsSection(page, "models", () => page.getByLabel("API Key", { exact: true }).fill("components-unsaved-key"));
    await expect(page.getByRole("heading", { name: "采集与转写组件", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "检查组件文件", exact: true }).click();
    await expect(page.getByRole("button", { name: "重新检查组件文件", exact: true })).toBeEnabled(); assert.equal(calls, 1);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("components-unsaved-key");
    await mkdir(".impeccable/review", { recursive: true });
    const section = page.getByRole("region", { name: "采集与转写组件", exact: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await section.screenshot({ path: `.impeccable/review/runtime-components-${suffix}.png` });
    }
  } finally { await browser.close(); await web.stop(); }
});
