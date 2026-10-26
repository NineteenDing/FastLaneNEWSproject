import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { mkdir } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { getBoss } from "@aihot/backend/jobs/queue";
import { creatorQueue } from "../backend/creator-collection.ts";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
test("情报搜索返回正文后段的实际匹配片段，普通列表与旧证据不改变", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "search-fragments", name: "镜头工具来源", kind: "rss", config: { feedUrl: "https://search.example/rss" } } })).statusCode, 200);
  const text = "先讲素材准备和环境要求。".repeat(50) + "在这里使用角色锁定，并保留原始镜头编号。";
  const news = await upsertMaterial({ sourceId: "search-fragments", title: "完整镜头制作流程", url: "https://search.example/one", via: "import",
    excerpt: "介绍准备工作和操作顺序", bodyText: text, bodyStatus: "ok" });
  const url = "/api/admin/studio/intelligence?q=" + encodeURIComponent("角色锁定");
  assert.equal((await app.inject({ url })).statusCode, 401);
  const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const result = response.json(); assert.equal(result.total, 1); assert.equal(result.rows[0].id, "news:" + news.articleId);
  assert.equal(result.rows[0].match.field, "body"); assert.ok(result.rows[0].match.text.includes("在这里使用角色锁定"));
  assert.ok(result.rows[0].match.text.length <= 400); assert.equal(result.rows[0].excerpt, "介绍准备工作和操作顺序");
  const ordinary = (await app.inject({ url: "/api/admin/studio/intelligence", headers })).json().rows[0];
  assert.equal(ordinary.match, undefined);
  assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/news:${news.articleId}`, headers })).json().body, text);
});

test("转写中的词有独立匹配片段，详情自动展开并定位已保存转写，不重新下载", async t => {
  const previous = getGlobalDispatcher(), transport = new MockAgent(); transport.disableNetConnect(); transport.enableNetConnect(/127\.0\.0\.1/); setGlobalDispatcher(transport);
  t.after(async () => { setGlobalDispatcher(previous); await transport.close(); }); config.allowPrivateNetworkFetch = true;
  const creator = (await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } })).json().creator;
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator.id}/collect`, headers, payload: {} })).statusCode, 200);
  bilibiliFixture(transport); const boss = await getBoss(), [job] = await boss.fetch(creatorQueue.name); assert.ok(job);
  await creatorQueue.run([job.data] as never[]); await boss.complete(creatorQueue.name, job.id);
  const post = (await app.inject({ url: `/api/admin/studio/creators/${creator.id}/contents`, headers })).json().rows[0];
  transport.get("https://media.example").intercept({ path: "/search.mp4" }).reply(200, Buffer.from("search-media-fixture"), { headers: { "content-type": "video/mp4" } });
  await createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://media.example/search.mp4", kind: "audio" }),
    recognize: async () => ({ language: "zh", durationSeconds: 8, model: "external-search-asr-fixture", segments: [{ start: 0, end: 4, text: "先做人物检查。" }, { start: 4, end: 8, text: "再使用自动口型对齐。" }] }),
  }).process(post.id);
  const response = await app.inject({ url: "/api/admin/studio/intelligence?q=" + encodeURIComponent("自动口型"), headers });
  assert.equal(response.json().rows[0].match.field, "transcript"); assert.ok(response.json().rows[0].match.text.includes("自动口型对齐"));
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/intelligence?q=" + encodeURIComponent("自动口型"));
    await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await expect(page.locator(".studio-material-link mark")).toHaveText("自动口型"); await page.locator(".studio-material-link").click();
    await expect(page.locator(".studio-transcript details")).toHaveAttribute("open", "");
    await page.getByRole("link", { name: "跳到首个匹配位置", exact: true }).click();
    await expect(page.locator("#intelligence-search-match")).toHaveText("自动口型"); await expect(page.locator("#intelligence-search-match")).toBeInViewport();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/intelligence-search-transcript-mobile.png" });
  } finally { await browser.close(); await web.stop(); }
  transport.assertNoPendingInterceptors();
});

test("搜索片段高亮并可跳到正文位置，原文HTML片段仍是文字，返回保留查询", async () => {
  const malicious = "使用 50%_mask 时，原样保存 <img src=x onerror=alert(1)> 这段来源文字。";
  await upsertMaterial({ sourceId: "search-fragments", title: "带符号的示例", url: "https://search.example/literal", via: "import", bodyText: malicious, bodyStatus: "ok" });
  const literal = (await app.inject({ url: "/api/admin/studio/intelligence?q=" + encodeURIComponent("50%_mask"), headers })).json();
  assert.equal(literal.total, 1); assert.equal(literal.rows[0].match.field, "body"); assert.ok(literal.rows[0].match.text.includes("50%_mask"));
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/intelligence?q=" + encodeURIComponent("角色锁定"));
    await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      const row = page.locator(".studio-material-link").filter({ hasText: "完整镜头制作流程" });
      await expect(row.locator("mark")).toHaveText("角色锁定");
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await page.screenshot({ path: `.impeccable/review/intelligence-search-list-${suffix}.png` });
      await row.click(); await expect(page.locator("#intelligence-search-match")).toHaveText("角色锁定");
      await page.getByRole("link", { name: "跳到首个匹配位置", exact: true }).click();
      await expect(page.locator("#intelligence-search-match")).toBeInViewport();
      await page.screenshot({ path: `.impeccable/review/intelligence-search-detail-${suffix}.png` });
      await page.getByRole("dialog", { name: "情报详情", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "搜索情报", exact: true })).toHaveValue("角色锁定");
    }
    await page.goto(web.origin + "/admin/studio/intelligence?q=" + encodeURIComponent("<img"));
    await page.locator(".studio-material-link").filter({ hasText: "带符号的示例" }).click();
    await expect(page.locator("#intelligence-search-match")).toHaveText("<img");
    await expect(page.locator(".studio-evidence-body img")).toHaveCount(0);
  } finally { await browser.close(); await web.stop(); }
});
