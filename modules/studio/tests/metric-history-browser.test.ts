import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir } from "node:fs/promises";
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

test("实际采集指标按作品绘图、缺失断开、精确值可展开，旧批次不随新观察变化且手机可读", async t => {
  await resources.warm();
  const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } });
  assert.equal(added.statusCode, 200); const creatorId = added.json().creator.id, boss = await getBoss();
  async function collect(views: number | null) {
    await resources.warm(); bilibiliFixture(transport, { views });
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creatorId}/collect`, headers, payload: {} })).statusCode, 200);
    const [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
    await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
    return (await app.inject({ url: `/api/admin/studio/creators/${creatorId}/contents`, headers })).json().rows[0];
  }
  const first = await collect(0), web = await startWebServer(app.server), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mkdir(".impeccable/review", { recursive: true });
  const path = `/admin/studio/intelligence/creator:${first.id}`;
  const panel = page.getByRole("region", { name: "作品热度变化", exact: true });
  async function capture(name: string) {
    await page.evaluate("window.scrollTo(0, 0); new Promise(requestAnimationFrame)");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: `.impeccable/review/metric-history-${name}.png`, fullPage: true });
  }
  try {
    await page.goto(web.origin + path);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(panel).toContainText("尚不足两个不同时间的有效观察");
    await expect(panel.getByRole("img")).toHaveCount(0);
    await panel.locator("summary").click(); await expect(panel).toContainText("播放 0");
    await page.setViewportSize({ width: 390, height: 1000 }); await capture("single-mobile");
    await collect(null); const latest = await collect(123456789);
    assert.deepEqual(latest.observations.map((row: { metrics: { views: number | null } }) => row.metrics.views), [0, null, 123456789]);
    await page.goto(web.origin + path); await expect(panel.getByRole("img")).toHaveAttribute("aria-label", /播放随观察时间变化/);
    await expect(panel).toContainText("播放变化 · 2 次有效观察");
    assert.equal((await panel.locator("svg > path").getAttribute("d"))!.includes("L"), false, "中间缺值不能连线或补零");
    await panel.getByLabel("热度指标").selectOption("comments"); await expect(panel).toContainText("评论变化 · 3 次有效观察");
    await panel.getByLabel("热度指标").selectOption("views");
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await capture(suffix);
    }
    await panel.locator("summary").click(); await expect(panel).toContainText("播放 123,456,789");
    await capture("exact-mobile");
    // Freeze through the real DB collection time; only scheduling uses the fake JS clock.
    const plan = (await app.inject({ url: "/api/admin/studio/topic-plan", headers })).json();
    const duration = 48 * 3600_000, collected = Date.parse(first.collectedAt);
    const window = Date.parse(plan.startsAt) + Math.floor((collected - Date.parse(plan.startsAt)) / duration) * duration;
    t.mock.timers.enable({ apis: ["Date"], now: new Date(window + duration + 1000) });
    let batchId = "";
    for (let start = Date.parse(plan.startsAt); start <= window; start += duration) {
      const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: new Date(start).toISOString() } });
      assert.equal(frozen.statusCode, 200); batchId = frozen.json().batch.id;
    }
    await collect(7);
    let liveReads = 0; page.on("request", request => { if (/\/intelligence\/[^/]+\/analysis$/.test(new URL(request.url()).pathname)) liveReads++; });
    await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`);
    await openTopicProcessing(page);
    await page.getByRole("region", { name: "冻结材料", exact: true }).locator("summary").first().click();
    await expect(panel).toContainText("冻结时保存的观察"); await expect(panel).toContainText("播放变化 · 2 次有效观察");
    await panel.locator("summary").click(); await expect(panel.locator("li")).toHaveCount(3); await expect(panel).toContainText("播放 123,456,789");
    await capture("frozen-mobile"); await page.waitForLoadState("networkidle"); assert.equal(liveReads, 0);
    transport.assertNoPendingInterceptors();
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
