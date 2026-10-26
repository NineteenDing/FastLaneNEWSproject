import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); transport.enableNetConnect(/^(127\.0\.0\.1|localhost)(:|$)/);
setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });

test("当期和冻结网页只绘最近100次观察，但冻结证据保留全部120次", async t => {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(added.statusCode, 200); const id = added.json().creator.id, boss = await getBoss();
  // Synthetic stress response repeats the same stable publication within the platform's 30-item bound.
  // The real collector/transaction retains one publication and records each received observation.
  for (const views of [100, 200, 300, 400]) {
    await resources.warm(); bilibiliFixture(transport, { views, copies: 30 });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${id}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
    await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  }
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current/materials", headers })).json();
  assert.equal(current.total, 1); assert.equal(current.rows[0].observations.length, 120);
  const web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.goto(web.origin + "/admin/studio/topics");
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "当期材料", exact: true }).locator("summary").first().click();
    const panel = page.getByRole("region", { name: "作品热度变化", exact: true });
    await expect(panel.locator("summary")).toHaveText("查看精确记录（100 次）");
    await panel.locator("summary").click(); await expect(panel.locator("li")).toHaveCount(100);
    const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json(), duration = 48 * 3600_000;
    const window = Date.parse(plan.startsAt) + Math.floor((Date.parse(current.rows[0].collectedAt) - Date.parse(plan.startsAt)) / duration) * duration;
    t.mock.timers.enable({ apis: ["Date"], now: new Date(window + duration + 1000) });
    let batchId = "";
    for (let start = Date.parse(plan.startsAt); start <= window; start += duration) {
      const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: new Date(start).toISOString() } });
      assert.equal(frozen.statusCode, 200); batchId = frozen.json().batch.id;
    }
    const frozen = (await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}/materials`, headers })).json();
    assert.equal(frozen.rows[0].observations.length, 120, "只限制显示，不丢弃完整历史证据");
    await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`);
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "冻结材料", exact: true }).locator("summary").first().click();
    await expect(panel.locator("summary")).toHaveText("查看精确记录（100 次）");
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
