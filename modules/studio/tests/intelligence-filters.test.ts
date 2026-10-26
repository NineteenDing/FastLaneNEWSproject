import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { closeDb } from "@aihot/backend/db";
import { stopBoss, getBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { config } from "@aihot/backend/config";
import { stub, Reply } from "../../../tests/setup.ts";
import { scheduleTopicMaterialAnalyses, topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Only this process's controlled localhost model stub.
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
const ids: string[] = [];
test("初筛状态在分页和日期统计前筛选，未完成不冒充已完成", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T10:00:00Z") });
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "intelligence-filters", name: "筛选来源", kind: "rss", config: { feedUrl: "https://filters.example/rss" } } })).statusCode, 200);
  for (const [name, body, bodyStatus] of [["人物检查", "先固定角色，再逐镜检查光线。", "ok"], ["工具口型", "先检查口型支持的语言，再做样片。", "ok"], ["未取得全文", "", "pending"]] as const) {
    const saved = await upsertMaterial({ sourceId: "intelligence-filters", title: name, url: "https://filters.example/" + ids.length, via: "import",
      discoveredAt: new Date("2026-10-17T09:00:00Z"), bodyText: body, bodyStatus }); ids.push("news:" + saved.articleId);
  }
  const url = "/api/admin/studio/intelligence?analysisState=pending&limit=1";
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().total, 3); assert.equal(response.json().rows.length, 1); assert.equal(response.json().hasMore, true);
  const next = await app.inject({ url: url + "&page=2", headers }); assert.notEqual(next.json().rows[0].id, response.json().rows[0].id);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?analysisState=completed", headers })).json().total, 0);
  const dates = await app.inject({ url: "/api/admin/studio/intelligence/dates?analysisState=pending&month=2026-10", headers });
  assert.equal(dates.statusCode, 200); assert.deepEqual(dates.json().days, [{ day: "2026-10-17", total: 3 }]);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?analysisState=not-real", headers })).statusCode, 400);
});

test("栏目状态组合可在实时与日期间切换，详情返回不丢筛选，零结果保留选择", async () => {
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/intelligence"); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await page.getByRole("link", { name: "日期归档", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索情报", exact: true }).fill("筛选");
    await page.getByRole("combobox", { name: "初筛栏目", exact: true }).selectOption("unclassified");
    await page.getByRole("combobox", { name: "初筛状态", exact: true }).selectOption("pending");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".studio-material-link")).toHaveCount(3);
    await mkdir(".impeccable/review", { recursive: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-filters-desktop.png" });
    await page.getByRole("link", { name: "日期归档", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "初筛栏目", exact: true })).toHaveValue("unclassified");
    await expect(page.getByRole("combobox", { name: "初筛状态", exact: true })).toHaveValue("pending");
    await page.locator(".studio-material-link").filter({ hasText: "人物检查" }).click();
    await page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "归档日期口径", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "初筛状态", exact: true })).toHaveValue("pending");
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-filters-mobile.png" });
    await page.getByRole("combobox", { name: "初筛栏目", exact: true }).selectOption("practice");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有匹配的情报", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "初筛栏目", exact: true })).toHaveValue("practice");
  } finally { await browser.close(); await web.stop(); }
});

test("栏目与真实初筛状态共同筛选，更正后的材料不沿用旧栏目，历史证据保留", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  const provider = await stub((_hit, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content), body = input.material.body as string;
    if (body.includes("口型")) return new Reply(503, { error: "isolated-provider-unavailable" });
    return { choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support", summary: "角色检查流程", reason: "有可演示步骤", viewerBenefit: "减少角色漂移", event: "角色检查", evidenceQuotes: [body], entities: [],
      gates: { audience: true, evidence: true, benefit: true }, dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 70, demand: null, distinctiveness: 70 } }) } }], usage: { prompt_tokens: 30, completion_tokens: 30 } };
  });
  t.after(() => provider.close()); Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-intelligence-filter-key", LLM_MODEL: "isolated-intelligence-filter-model" });
  const web = await startWebServer(app.server), browser = await chromium.launch();
  t.after(async () => { await browser.close(); await web.stop(); });
  const page = await browser.newPage();
  await page.goto(web.origin + "/admin/studio/intelligence?column=practice&analysisState=completed");
  await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
  await expect(page.getByRole("heading", { name: "没有匹配的情报", exact: true })).toBeVisible();
  await page.clock.install();
  await scheduleTopicMaterialAnalyses(); const boss = await getBoss(), jobs = await boss.fetch(topicAnalysisQueue.name, { batchSize: 10 }); assert.equal(jobs.length, 2);
  for (const job of jobs) {
    if ((job.data as { live: { materialId: string } }).live.materialId === ids[1]) { await assert.rejects(topicAnalysisQueue.run([job.data] as never[])); await boss.fail(topicAnalysisQueue.name, job.id); }
    else { await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id); }
  }
  const poll = page.waitForResponse(response => response.url().includes("/api/admin/studio/intelligence?") && response.url().includes("limit=1"));
  await page.clock.fastForward(30_001); assert.equal((await poll).status(), 200);
  await expect(page.getByRole("link", { name: "筛选结果有更新，点击加载", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /条新内容/ })).toHaveCount(0);
  await page.getByRole("link", { name: "筛选结果有更新，点击加载", exact: true }).click();
  await expect(page.locator(".studio-material-link")).toHaveCount(1);
  const read = async (query: string) => app.inject({ url: "/api/admin/studio/intelligence?" + query, headers });
  for (const [state, id] of [["completed", ids[0]], ["failed", ids[1]], ["waiting_body", ids[2]]] as const) {
    const response = await read("analysisState=" + state); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().total, 1); assert.equal(response.json().rows[0].id, id);
  }
  const matched = await read("column=practice&analysisState=completed&limit=1&q=" + encodeURIComponent("筛选")); assert.equal(matched.statusCode, 200, matched.body); assert.equal(matched.json().total, 1);
  assert.equal((await read("column=practice&analysisState=failed")).json().total, 0);
  assert.equal((await read("column=unclassified")).json().total, 2);
  const dates = await app.inject({ url: "/api/admin/studio/intelligence/dates?column=practice&analysisState=completed&month=2026-10", headers });
  assert.equal(dates.statusCode, 200); assert.deepEqual(dates.json().days, [{ day: "2026-10-17", total: 1 }]);
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } }); assert.equal(frozen.statusCode, 200, frozen.body);
  const prefix = `/api/admin/studio/topic-batches/${frozen.json().batch.id}`;
  await upsertMaterial({ sourceId: "intelligence-filters", title: "人物检查", url: "https://filters.example/0", via: "import", discoveredAt: new Date("2026-10-17T09:00:00Z"), bodyText: "更正：还需要逐镜检查服装与光线。", bodyStatus: "ok" });
  assert.equal((await read("column=practice")).json().total, 0); assert.equal((await read("column=unclassified&analysisState=pending")).json().total, 1);
  const old = (await app.inject({ url: prefix + "/materials", headers })).json().rows.find((row: {id: string}) => row.id === ids[0]); assert.equal(old.body, "先固定角色，再逐镜检查光线。");
  const calls = provider.hits(); await read("column=unclassified"); await app.inject({ url: "/api/admin/studio/intelligence/dates?analysisState=pending", headers }); assert.equal(provider.hits(), calls);
});
