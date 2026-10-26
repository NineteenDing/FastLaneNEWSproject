import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { createServer, request as forwardRequest } from "node:http";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer, type WebServer } from "../../../apps/web/tests/web-server.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { stub } from "../../../tests/setup.ts";
import { topicAnalysisQueue } from "../backend/topic-material-analysis.ts";
import { topicGenerationQueue } from "../backend/topic-directions.ts";
import { topicReviewQueue } from "../backend/topic-review.ts";
import { openTopicProcessing } from "./topic-processing-navigation.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Controlled localhost provider in this test process only.
let browser: Browser, web: WebServer, unavailable = false, batchId: string;
before(async () => {
  await resources.warm(); config.siteUrl = "http://127.0.0.1";
  const apiOrigin = await listenHttpForFetch(app.server);
  const api = createServer((request, response) => {
    if (unavailable && request.url?.startsWith("/api/admin/studio/topic-batches")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{}'); return; }
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  web = await startWebServer(api); browser = await chromium.launch(); await mkdir(".impeccable/review", { recursive: true });
});
after(async () => { await browser?.close(); await web?.stop(); await app.close(); await stopBoss(); await closeDb(); });
async function login(page: Page) {
  await page.goto(web.origin + "/admin/studio/topics");
  await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
  await expect(page.getByRole("heading", { name: "当期选题", exact: true })).toBeVisible(); await page.waitForLoadState("networkidle");
}
async function expandProcessing(page: Page) {
  await openTopicProcessing(page);
}
async function capture(page: Page, name: string) {
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
  await page.evaluate("window.scrollTo(0, 0)"); await page.screenshot({ path: `.impeccable/review/topic-batches-${name}.png`, fullPage: true });
}

test("当期与历史空状态如实显示，默认选题台和栏目规则往返保持各自任务", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await login(page);
    await expect(page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "当期", exact: true })).toHaveAttribute("aria-current", "page");
    await expandProcessing(page);
    await expect(page.getByText("本期还没有收录材料", { exact: true })).toBeVisible();
    await expect(page.getByText("0 条材料 · 收集中 · 选题尚未生成", { exact: true })).toBeVisible();
    await capture(page, "empty-desktop");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture(page, "empty-mobile");
    await page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "历史", exact: true }).click();
    await expect(page.getByRole("heading", { name: "还没有历史批次", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "栏目规则", exact: true }).click();
    await expect(page.getByRole("button", { name: "添加栏目", exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(5);
    await page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "当期", exact: true }).click();
    await expect(page.getByRole("heading", { name: "当期选题", exact: true })).toBeVisible();
    await expandProcessing(page);
    await expect(page.getByText("本期还没有收录材料", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

test("当期实际材料和历史快照独立，改名/更正正文后仍可读旧材料和旧规则，窄屏长正文可展开", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "batch-browser-news", name: "影视创作观察", kind: "rss", config: { feedUrl: "https://batch-browser.example/rss" } } })).statusCode, 200);
  const current = (await app.inject({ url: "/api/admin/studio/topic-batches/current", headers })).json();
  const oldStart = new Date(new Date(current.startsAt).getTime() - 48 * 3600_000), oldCollected = new Date(oldStart.getTime() + 3600_000);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/topic-plan", headers,
    payload: { version: 0, enabled: false, startsAt: oldStart.toISOString() } })).statusCode, 200);
  await upsertMaterial({ sourceId: "batch-browser-news", title: "角色一致性的历史更新", url: "https://batch-browser.example/old", via: "import",
    discoveredAt: oldCollected, publishedAt: new Date(oldCollected.getTime() - 3600_000), bodyText: "当时的完整正文：先固定参考图，再分镜生成，保留未验证的限制。".repeat(35), bodyStatus: "ok" });
  await resources.warm();
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: oldStart.toISOString() } });
  assert.equal(frozen.statusCode, 200); batchId = frozen.json().batch.id;
  assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/studio/columns/practice", headers, payload: { version: 1, name: "新名称的实操栏目" } })).statusCode, 200);
  await upsertMaterial({ sourceId: "batch-browser-news", title: "实时内容已经改名", url: "https://batch-browser.example/old", via: "import", bodyText: "实时内容已更正", bodyStatus: "ok" });
  await upsertMaterial({ sourceId: "batch-browser-news", title: "当期镜头控制的新方法", url: "https://batch-browser.example/current", via: "import",
    publishedAt: new Date(), excerpt: "了解适用条件和制作检查点", bodyText: "当前材料完整正文：镜头控制需要结合角色参考，尚无实测保证。", bodyStatus: "ok" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await login(page);
    await expandProcessing(page);
    await expect(page.getByText("1 条材料 · 收集中 · 选题尚未生成", { exact: true })).toBeVisible();
    await expect(page.locator("summary").getByText("当期镜头控制的新方法", { exact: true })).toBeVisible();
    await capture(page, "current-desktop");
    await page.setViewportSize({ width: 1024, height: 1100 }); await capture(page, "current-tablet");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture(page, "current-mobile");
    await page.getByRole("navigation", { name: "选题视图" }).getByRole("link", { name: "历史", exact: true }).click();
    const history = page.getByRole("complementary", { name: "历史批次" }); await expect(history.getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "批次概览" })).toContainText("1 条材料"); await expect(history).toContainText("已确认 0 篇"); await capture(page, "history-mobile");
    await history.getByRole("link").click(); await expect(page.getByRole("heading", { name: "历史选题", exact: true })).toBeVisible(); await expandProcessing(page);
    await page.getByText("查看本批次保存的栏目规则", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "实操与提效 · 版本 1", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "实操与提效 · 版本 1", exact: true }).locator("..")).not.toContainText("新名称的实操栏目");
    await page.getByText("查看本批次保存的栏目规则", { exact: true }).click();
    await page.locator("summary").getByText("角色一致性的历史更新", { exact: true }).click();
    await expect(page.getByText("当时的完整正文：先固定参考图，再分镜生成，保留未验证的限制。".repeat(35), { exact: true })).toBeVisible();
    await expect(page.getByText("实时内容已更正", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "打开原文或原作品", exact: true })).toHaveAttribute("href", "https://batch-browser.example/old");
    await capture(page, "snapshot-mobile");
    await page.setViewportSize({ width: 1440, height: 1100 }); await capture(page, "snapshot-desktop");
    await page.goto(web.origin + "/admin/studio/topics?view=history"); await expect(page.getByRole("complementary", { name: "历史批次" })).toBeVisible();
  } finally { await page.close(); }
});

test("实际API不可用时显示本地恢复入口，重载恢复；不存在的历史批次不显示空推荐", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1100 } });
  try {
    await login(page); unavailable = true;
    await page.reload(); await expect(page.getByRole("heading", { name: "选题批次未能加载", exact: true })).toBeVisible();
    await capture(page, "error-mobile"); unavailable = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(page.getByRole("heading", { name: "当期选题", exact: true })).toBeVisible();
    await page.goto(web.origin + "/admin/studio/topics/batches/00000000-0000-0000-0000-000000000000");
    await expect(page.getByRole("heading", { name: "批次暂不可用", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回历史", exact: true }).click();
    await page.getByRole("complementary", { name: "历史批次" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`batch=${batchId}`));
    assert.equal(new URL(page.url()).searchParams.get("batch"), batchId);
  } finally { unavailable = false; await page.close(); }
});

test("历史材料可提交持久分析，按当时栏目展示初筛和缺口，详情含原文依据且刷新不重复调用模型", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ columnId: "practice", disposition: "support",
    summary: "先固定角色参考，再分镜生成", reason: "给出具体流程与限制", viewerBenefit: "减少镜头间的角色漂移", event: "角色参考流程",
    evidenceQuotes: ["先固定参考图，再分镜生成"], entities: [], gates: { audience: true, evidence: true, benefit: true },
    dimensions: { audience: 80, practical: 90, evidence: 70, freshness: 60, demand: null, distinctiveness: 50 },
  }) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "browser-analysis-test-key", LLM_MODEL: "browser-analysis-test-model" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    config.modelCallsEnabled = false;
    await login(page); await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`); await expandProcessing(page);
    await expect(page.getByRole("button", { name: "补齐分析与重试", exact: true })).toBeDisabled();
    assert.equal(provider.hits(), 0);
    config.modelCallsEnabled = true; await page.reload(); await expandProcessing(page);
    await expect(page.getByText("待分析", { exact: true })).toBeVisible();
    unavailable = true; await page.getByRole("button", { name: "补齐分析与重试", exact: true }).click();
    await expect(page.getByText("请求失败（503）", { exact: true })).toBeVisible();
    await expect(page.getByText("请求失败（503）", { exact: true })).toHaveCSS("opacity", "1");
    await expect(page.getByText("待分析", { exact: true })).toBeVisible();
    await capture(page, "analysis-error-desktop"); unavailable = false;
    await page.getByRole("button", { name: "补齐分析与重试", exact: true }).click();
    await expect(page.getByText("已提交 1 条材料，后台继续分析。", { exact: true })).toBeVisible();
    await expect(page.getByText("已排队", { exact: true })).toBeVisible();
    const boss = await getBoss(), [job] = await boss.fetch(topicAnalysisQueue.name); assert.ok(job);
    await topicAnalysisQueue.run([job.data] as never[]); await boss.complete(topicAnalysisQueue.name, job.id);
    await page.getByRole("button", { name: "刷新分析进度", exact: true }).click();
    await expect(page.getByText("已分析 · 实操与提效 · 方向依据 · 初筛 67.5 / 100", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "补齐分析与重试", exact: true })).toBeDisabled();
    await page.locator("summary").getByText("角色一致性的历史更新", { exact: true }).click();
    await expect(page.getByText(/信息缺口：.*缺少可比较的关注需求信号/)).toBeVisible();
    await page.getByText("查看评分与原文依据", { exact: true }).click();
    await expect(page.getByRole("blockquote")).toContainText("先固定参考图，再分镜生成");
    await expect(page.getByText("请求失败（503）", { exact: true })).toBeHidden({ timeout: 10_000 });
    await capture(page, "analysis-desktop");
    await page.setViewportSize({ width: 390, height: 1100 }); await capture(page, "analysis-mobile");
    await page.getByRole("button", { name: "刷新分析进度", exact: true }).click();
    await expect(page.getByText("已分析 · 实操与提效 · 方向依据 · 初筛 67.5 / 100", { exact: true })).toBeVisible();
    assert.equal(provider.hits(), 1);
  } finally { unavailable = false; await page.close(); await provider.close(); config.modelCallsEnabled = false; }
});

test("综合初版按历史栏目查看七点、标题和真实来源，关闭模型禁用提交，失败可恢复且刷新不重复生成", async () => {
  const list = (await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}/materials`, headers })).json(), materialId = list.rows[0].id;
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ directions: [{ id: "character-reference", columnId: "practice", eventKey: "character-workflow",
    question: "连续镜头的角色总变脸，应该先检查哪一步？", viewerBenefit: "固定角色参考后再生成分镜，减少角色漂移", whyNow: "材料提供了流程步骤及尚未验证的限制",
    angle: "用同一角色对照两个镜头", usage: { steps: ["准备角色参考", "生成镜头并检查"], conditions: ["已有角色参考图"], limitations: ["效果需要自行测试"] },
    titles: ["角色总变脸？先固定参考图", "连续镜头如何保住同一角色", "AI漫剧角色参考怎么准备"], preferredTitle: 0,
    structure: { opening: "先给出漂移问题", rhythm: "对照、步骤、限制", ending: "给出下一步检查方法" },
    references: [{ materialId, role: "fact", quote: "先固定参考图，再分镜生成", reason: "来源给出步骤与限制" }],
    dimensions: { audience: 90, practical: 90, evidence: 80, freshness: 80, demand: null, distinctiveness: 70 }, gates: { audience: true, evidence: true, benefit: true },
  }], assignments: [{ materialId, columnId: "practice", disposition: "support", directionIds: ["character-reference"], reason: "工作流依据" }] }) } }], usage: { prompt_tokens: 30, completion_tokens: 30 } }));
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "browser-direction-key", LLM_MODEL: "browser-direction-model" });
  const page = await browser.newPage({ viewport: { width: 390, height: 1100 } });
  try {
    await login(page); await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`); await expandProcessing(page);
    await page.getByText("查看生成时的选题初版", { exact: true }).click();
    const section = page.getByRole("region", { name: "综合选题初版", exact: true });
    await expect(section.getByRole("button", { name: "生成选题初版", exact: true })).toBeDisabled();
    await capture(page, "directions-empty-mobile");
    config.modelCallsEnabled = true; await page.reload(); await expandProcessing(page); await page.getByText("查看生成时的选题初版", { exact: true }).click(); unavailable = true;
    await section.getByRole("button", { name: "生成选题初版", exact: true }).click();
    await expect(page.getByText("请求失败（503）", { exact: true })).toHaveCSS("opacity", "1");
    await expect(section).toContainText("初版尚未生成"); await capture(page, "directions-error-mobile");
    unavailable = false; await section.getByRole("button", { name: "生成选题初版", exact: true }).click();
    await expect(section).toContainText("生成任务已排队");
    const boss = await getBoss(), [job] = await boss.fetch(topicGenerationQueue.name); assert.ok(job);
    await topicGenerationQueue.run([job.data] as never[]); await boss.complete(topicGenerationQueue.name, job.id);
    await section.getByRole("button", { name: "刷新选题进度", exact: true }).click();
    await expect(section).toContainText("初版已保存 · 审核未开始");
    const column = section.locator(".studio-direction-column").filter({ hasText: "实操与提效" });
    await column.locator(":scope > summary").click(); await column.locator(".studio-direction > summary").click();
    // No observed heat/freshness/impact: 90×15% + 80×15% + 70×5% = 29; unknown dimensions earn no points.
    await expect(column).toContainText("初版方向分 29.0 / 100"); await expect(column).toContainText("六维基础分 29.00"); await expect(column).toContainText("角色总变脸？先固定参考图（首选）");
    await column.getByText("支撑材料与表达参考（1）", { exact: true }).click();
    await expect(column.getByRole("link", { name: "查看来源原文", exact: true })).toHaveAttribute("href", "https://batch-browser.example/old");
    await expect(section.locator(".studio-direction-column")).toHaveCount(5);
    await expect(page.getByText("请求失败（503）", { exact: true })).toBeHidden({ timeout: 10_000 });
    await capture(page, "directions-mobile"); await page.setViewportSize({ width: 1440, height: 1100 }); await capture(page, "directions-desktop");
    await section.getByRole("button", { name: "刷新选题进度", exact: true }).click();
    await expect(section).toContainText("初版已保存 · 审核未开始"); assert.equal(provider.hits(), 1);
    await page.getByRole("navigation", { name: "选题视图", exact: true }).getByRole("link", { name: "历史", exact: true }).click();
    await expect(page.getByRole("region", { name: "批次概览" })).toContainText("选题初版已保存，待审核");
  } finally { unavailable = false; await page.close(); await provider.close(); config.modelCallsEnabled = false; }
});

test("自动审核展示真实排队与两轮修改、自动采纳说明和最终方向，保留独立初稿与未采纳历史", async () => {
  const provider = await stub((_hit, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    let result: unknown;
    if (input.task === "review_packet") result = { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: [{ id: `issue-${input.round}`,
      directionIds: [input.recommendation.directions[0].id], materialIds: [input.parts[0].materialId], kind: input.round === 1 ? "evidence" : "timing", severity: "major",
      problem: input.round === 1 ? "标题没有交代适用条件" : "演示步骤需要压缩", suggestion: input.round === 1 ? "保留未验证限制" : "只演示最关键的两步" }] };
    else if (input.task === "review_summary") result = { passed: false, opinionIds: input.opinions.map((item: { id: string }) => item.id), summary: "有修改建议，自动继续修订" };
    else {
      const recommendation = structuredClone(input.recommendation);
      delete recommendation.filterPolicy; delete recommendation.sharedSignals;
      for (const direction of recommendation.directions) delete direction.score;
      if (input.task === "revise") {
        recommendation.directions[0].id = "character-revised";
        for (const assignment of recommendation.assignments) assignment.directionIds = ["character-revised"];
      }
      recommendation.directions[0].titles[0] = input.task === "revise" ? "参考图如何保持同一角色" : "角色参考的条件与两步演示";
      result = { recommendation, decisions: input.opinions.map((item: { id: string }, index: number) => ({ opinionId: item.id, decision: index ? "partial" : "accept",
        reason: index ? "保留关键检查，压缩重复演示" : "来源没有实测保证，保留条件" })), summary: "已补充适用条件，并缩减重复演示。" };
    }
    return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
  });
  Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "browser-review-key", LLM_MODEL: "browser-review-model" });
  const page = await browser.newPage({ viewport: { width: 390, height: 1100 } });
  try {
    await login(page); await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`); await expandProcessing(page);
    const section = page.getByRole("region", { name: "自动审核", exact: true });
    await expect(section.getByRole("button", { name: "开始自动审核", exact: true })).toBeDisabled();
    await expect(section).toContainText("审核未开始"); await capture(page, "review-empty-mobile");
    config.modelCallsEnabled = true; await page.reload(); await expandProcessing(page); unavailable = true;
    await section.getByRole("button", { name: "开始自动审核", exact: true }).click();
    await expect(page.getByText("请求失败（503）", { exact: true })).toHaveCSS("opacity", "1"); await capture(page, "review-error-mobile");
    unavailable = false; await section.getByRole("button", { name: "开始自动审核", exact: true }).click();
    await expect(section).toContainText("审核已排队"); await expect(section.getByRole("button", { name: "开始自动审核", exact: true })).toBeDisabled();
    const boss = await getBoss(), [job] = await boss.fetch(topicReviewQueue.name); assert.ok(job);
    await topicReviewQueue.run([job.data] as never[]); await boss.complete(topicReviewQueue.name, job.id);
    const refresh = section.getByRole("button", { name: "刷新审核进度", exact: true }); await refresh.focus(); await page.keyboard.press("Enter");
    await expect(section.getByText("已完成两轮审核并修订", { exact: true })).toBeVisible();
    await expect(section.getByText("已补充适用条件，并缩减重复演示。", { exact: true })).toBeVisible();
    await expect(section.getByRole("heading", { name: "最终选题推荐", exact: true })).toBeVisible();
    await section.getByText("查看审核记录（2 轮）", { exact: true }).click();
    await expect(section.getByRole("heading", { name: "第 1 轮 · 需修改", exact: true })).toBeVisible();
    await expect(section.getByRole("heading", { name: "第 2 轮 · 需修改", exact: true })).toBeVisible();
    await section.getByText("查看意见采纳与修改（2 项）", { exact: true }).click();
    await expect(section).toContainText("采纳：标题没有交代适用条件"); await expect(section).toContainText("部分采纳：演示步骤需要压缩");
    const column = section.locator(".studio-direction-column").filter({ hasText: "实操与提效" });
    await column.locator(":scope > summary").click(); await column.locator(".studio-direction > summary").click();
    await expect(column).toContainText("角色参考的条件与两步演示（首选）");
    await column.getByText("支撑材料与表达参考（1）", { exact: true }).click();
    await expect(column.getByRole("link", { name: "查看来源原文", exact: true })).toHaveAttribute("href", "https://batch-browser.example/old");
    await section.getByText("重要问题：标题没有交代适用条件", { exact: true }).click();
    await section.getByRole("link", { name: "关联方向：角色总变脸？先固定参考图（初版）", exact: true }).click();
    await expect(page.locator("#topic-draft-character-reference")).toHaveAttribute("open", "");
    await expect(page.locator("#topic-draft-character-reference").getByText("角色总变脸？先固定参考图（首选）", { exact: true })).toBeVisible();
    await page.getByText("查看生成时的选题初版", { exact: true }).click();
    await section.getByText("重要问题：演示步骤需要压缩", { exact: true }).click();
    await section.getByRole("link", { name: "关联方向：角色参考的条件与两步演示", exact: true }).click();
    await expect(page.locator("#topic-final-character-revised")).toHaveAttribute("open", "");
    await expect(page.getByText("请求失败（503）", { exact: true })).toBeHidden({ timeout: 10_000 });
    await capture(page, "review-mobile"); await page.setViewportSize({ width: 1440, height: 1100 }); await capture(page, "review-desktop");
    const hits = provider.hits(); await refresh.click(); await expect(section).toContainText("已完成两轮审核并修订"); assert.equal(provider.hits(), hits);
    await page.getByText("查看生成时的选题初版", { exact: true }).click();
    const original = page.getByRole("region", { name: "综合选题初版", exact: true }); await expect(original).toContainText("角色总变脸？先固定参考图");
    await page.getByRole("navigation", { name: "选题视图", exact: true }).getByRole("link", { name: "历史", exact: true }).click();
    await expect(page.getByRole("region", { name: "批次概览" })).toContainText("两轮审核并修订已完成");
    const savedBatch = (await app.inject({ url: `/api/admin/studio/topic-batches/${batchId}`, headers })).json().batch;
    await expect(page.getByRole("complementary", { name: "历史批次" })).toContainText(savedBatch.selectionState === "incomplete" ? "未完成" : "未采纳");
    await page.getByRole("textbox", { name: "日期或标题", exact: true }).fill("角色参考的条件与两步演示");
    await page.getByRole("button", { name: "查找", exact: true }).click();
    await expect(page).toHaveURL(/q=/); await expect(page.locator(".studio-topic-direction-button")).toHaveCount(1);
    await page.getByRole("textbox", { name: "日期或标题", exact: true }).fill("不存在的独立选题");
    await page.getByRole("button", { name: "查找", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有符合条件的批次", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "清除", exact: true }).click();
    await expect(page.locator(".studio-topic-direction-button")).toHaveCount(1);
  } finally { unavailable = false; await page.close(); await provider.close(); config.modelCallsEnabled = false; }
});

test("栏目弹窗可搜索批选全库并查看内容，批量链接保存后重新打开仍显示原期次进度", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await login(page); await page.goto(web.origin + `/admin/studio/topics/batches/${batchId}`);
    await page.getByRole("region", { name: "实操与提效", exact: true }).getByRole("button", { name: "增加新闻来源", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "增加新闻来源 · 实操与提效", exact: true }); await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "搜索补充材料", exact: true }).fill("当期镜头控制的新方法");
    await dialog.getByRole("button", { name: "搜索", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "选择：当期镜头控制的新方法", exact: true }).check();
    await expect(dialog).toContainText("已选 1 / 50 条"); await dialog.getByRole("button", { name: "查看内容", exact: true }).click();
    const reader = page.getByRole("dialog", { name: "情报详情", exact: true }); await expect(reader).toContainText("当前材料完整正文"); await reader.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.getByRole("button", { name: "补充到本栏并更新选题", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已补充 1 条材料"); await expect(dialog.getByRole("link", { name: "查看更新后的选题", exact: true })).toBeVisible();
    await capture(page, "supplement-desktop"); await page.setViewportSize({ width: 390, height: 1100 }); await capture(page, "supplement-mobile");
    await dialog.getByRole("button", { name: "批量粘贴链接", exact: true }).click();
    await dialog.getByRole("textbox", { name: "栏目批量参考链接", exact: true }).fill("https://batch-browser.example/current\nhttps://www.xiaohongshu.com/explore/670000000000000001234567?xsec_token=kept-reference-token&xsec_source=pc_feed");
    await dialog.getByRole("button", { name: "读取并补充本栏", exact: true }).click(); await expect(dialog).toContainText("链接已保存到本期本栏");
    await expect(dialog.getByRole("link", { name: /kept-reference-token/ })).toHaveAttribute("href", /xsec_token=kept-reference-token/);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("region", { name: "实操与提效", exact: true }).getByRole("button", { name: "增加新闻来源", exact: true }).click();
    await dialog.getByRole("button", { name: "批量粘贴链接", exact: true }).click();
    await expect(dialog.getByRole("link", { name: "https://batch-browser.example/current", exact: true })).toBeVisible();
    await capture(page, "supplement-links-mobile"); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  } finally { await page.close(); }
});
