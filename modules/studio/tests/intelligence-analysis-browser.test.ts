import { openTopicProcessing } from "./topic-processing-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only this process's controlled localhost model stub.
const quote = "先固定角色参考，再逐镜头检查一致性。";
const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
  summary: "固定参考图后逐镜头检查角色", reason: "原文列出可复现的检查步骤及适用条件", viewerBenefit: "减少跨镜头返工",
  event: "角色检查流程", evidenceQuotes: [quote], entities: [], gates: { audience: true, evidence: true, benefit: true },
  dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 },
}) } }], usage: { prompt_tokens: 50, completion_tokens: 50 } }));
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "isolated-browser-key", LLM_MODEL: "isolated-browser-model" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("实际情报网页读取初筛、显式重试、故障保留及源更正隔离，冻结阅读不请求实时分析", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "reading-ui", name: "影视制作观察",
    kind: "rss", config: { feedUrl: "https://reading-ui.example/feed" } } })).statusCode, 200);
  const input = { sourceId: "reading-ui", title: "角色一致性：从参考图到逐镜头检查的可复现工作流", url: "https://reading-ui.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T09:00:00Z"), publishedAt: new Date("2026-10-17T08:00:00Z"), bodyStatus: "ok" as const };
  const saved = await upsertMaterial({ ...input, bodyText: quote + "\n检查时需要保留同一参考图，变化过大的景别应单独复核。" });
  const id = "news:" + saved.articleId, api = `/api/admin/studio/intelligence/${id}/analysis`;
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), [cancelled] = await boss.fetch(topicAnalysisQueue.name); assert.ok(cancelled);
  await boss.cancel(topicAnalysisQueue.name, cancelled.id);
  const web = await startWebServer(app.server), browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mkdir(".impeccable/review", { recursive: true });
  try {
    await page.goto(web.origin + `/admin/studio/intelligence/${id}`);
    await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const panel = page.getByRole("region", { name: "已保存的材料初筛", exact: true });
    await expect(panel.getByText("初筛需重试", { exact: true })).toBeVisible();
    assert.equal(provider.hits(), 0);
    await panel.getByRole("button", { name: "重试材料分析", exact: true }).click();
    await expect(panel.getByText("初筛已排队", { exact: true })).toBeVisible();
    const [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job); await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click();
    await expect(panel.getByText("固定参考图后逐镜头检查角色", { exact: true })).toBeVisible();
    await expect(panel.getByText("已提交重试，后台继续处理。", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("分析时栏目：实操与提效 · 版本 1", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重试材料分析", exact: true })).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({ path: `.impeccable/review/intelligence-analysis-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await panel.getByText("查看评分与原文依据", { exact: true }).click();
    await expect(panel.getByRole("blockquote")).toHaveText(quote);
    await page.route("**/api/admin/studio/intelligence/*/analysis", route => route.fulfill({ status: 503, body: "unavailable" }));
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("暂时无法读取");
    await expect(panel.getByText("固定参考图后逐镜头检查角色", { exact: true })).toBeVisible();
    await expect(page.getByText("检查时需要保留同一参考图", { exact: false })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/intelligence-analysis-error-390.png", fullPage: true });
    await page.unroute("**/api/admin/studio/intelligence/*/analysis");
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click(); await expect(panel.getByRole("alert")).toHaveCount(0);
    let previewReads = 0;
    const trackPreview = (request: { url(): string }) => { if (new URL(request.url()).pathname === api) previewReads++; };
    page.on("request", trackPreview);
    await page.goto(web.origin + "/admin/studio/topics");
    await openTopicProcessing(page);
    const current = (await app.inject({url: "/api/admin/studio/topic-batches/current/materials", headers})).json();
    assert.equal(current.total, 1); assert.deepEqual(current.rows.map((item: {analysisState: string}) => item.analysisState), ["completed"]);
    await expect(page.getByRole("region", {name: "当期材料", exact: true})).toContainText("初筛已完成");
    await page.waitForLoadState("networkidle"); assert.equal(previewReads, 0, "当期折叠材料不启动逐条状态请求");
    await page.getByRole("region", { name: "当期材料", exact: true }).locator("summary").click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({ path: `.impeccable/review/current-analysis-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    }
    await page.getByRole("link", { name: "查看情报与初筛分析", exact: true }).click();
    await expect(panel.getByText("初筛已完成", { exact: true })).toBeVisible(); page.off("request", trackPreview);
    config.modelCallsEnabled = false; await page.reload();
    await expect(panel.getByText("固定参考图后逐镜头检查角色", { exact: true })).toBeVisible();
    assert.equal(provider.hits(), 1, "阅读和状态刷新不调用模型"); config.modelCallsEnabled = true;
    await upsertMaterial({ ...input, bodyText: quote + "\n新增条件：这一方法只适用于固定角色。" });
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click();
    await expect(panel.getByText("内容已更新，请刷新这条情报后查看对应分析。", { exact: true })).toBeVisible();
    await expect(panel.getByText("固定参考图后逐镜头检查角色", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "刷新情报", exact: true }).click();
    await expect(page.getByText("新增条件：这一方法只适用于固定角色。", { exact: false })).toBeVisible();
    await expect(panel.getByText("初筛待安排", { exact: true })).toBeVisible();
    t.mock.timers.setTime(new Date("2026-10-18T12:00:00Z").getTime()); await resources.warm();
    const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
    assert.equal(frozen.statusCode, 200); const batchId = frozen.json().batch.id;
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${batchId}/analysis`, headers, payload: {} })).statusCode, 200);
    await panel.getByRole("button", { name: "刷新分析状态", exact: true }).click();
    await expect(panel.getByRole("link", { name: "前往所属批次", exact: true })).toHaveAttribute("href", `/admin/studio/topics/batches/${batchId}`);
    let liveReads = 0; page.on("request", request => { if (new URL(request.url()).pathname === api) liveReads++; });
    await panel.getByRole("link", { name: "前往所属批次", exact: true }).click();
    await expect(page.getByRole("heading", { name: "历史批次", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle"); assert.equal(liveReads, 0, "冻结阅读不请求实时初筛"); assert.equal(provider.hits(), 1);
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
