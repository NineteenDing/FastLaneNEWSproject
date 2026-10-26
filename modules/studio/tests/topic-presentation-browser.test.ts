import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("当期页面保持打开跨第三天午夜时自动切期，不等人工刷新且不修改旧批次", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  config.modelCallsEnabled = false; await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); const batchId = frozen.json().batch.id;
  const before = new Date("2026-10-19T15:59:59Z"); t.mock.timers.setTime(before.getTime());
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.clock.install({ time: before });
    await page.goto(web.origin + "/admin/studio/topics");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("region", { name: "批次概览", exact: true })).toBeVisible();
    await expect(page.getByText("本期显示至", { exact: false })).toBeVisible();
    t.mock.timers.setTime(new Date("2026-10-19T16:00:01Z").getTime());
    await page.clock.runFor(2000);
    await expect(page.getByRole("region", { name: "当期概览", exact: true })).toBeVisible();
    await expect(page.getByText("本期显示至", { exact: false })).toHaveCount(0);
    const history = await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}`, headers });
    assert.equal(history.statusCode, 200); assert.equal(history.json().batch.selectionState, "incomplete");
  } finally { await browser.close(); await web.stop(); }
});
