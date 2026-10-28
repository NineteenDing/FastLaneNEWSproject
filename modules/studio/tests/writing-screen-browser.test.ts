import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

process.env.COLLECT_ENABLED = "false"; config.modelCallsEnabled = false;
const { app, headers } = await sourceResourceFixture();
await app.ready();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("纯文字正文和资料侧栏独立滚动，工具弹窗保留选区和输入，图片不进入正文", async () => {
  const seeded = await app.inject({ method: "POST", url: "/api/admin/studio/acceptance-examples", headers, payload: {} });
  assert.equal(seeded.statusCode, 200, seeded.body);
  const rows = (await app.inject({ url: "/api/admin/studio/drafts", headers })).json().rows;
  const id = rows[0].id, endpoint = `/api/admin/studio/drafts/${id}`;
  const draft = (await app.inject({ url: endpoint, headers })).json();
  const content = { ...draft.content, spoken: "先固定角色参考图，再核对镜头。\n\n" + "这一段用来验证长口播内部滚动，保留原始材料的限制条件。\n\n".repeat(80) };
  const saved = await app.inject({ method: "PATCH", url: endpoint, headers, payload: { version: draft.version, content } });
  assert.equal(saved.statusCode, 200, saved.body);
  const web = await startWebServer(app.server), browser = await chromium.launch();
  await mkdir(".impeccable/review", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(web.origin + `/admin/studio/writing/${id}`);
    await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    const rail = page.getByRole("complementary", { name: "本稿资料" });
    await expect(rail.getByRole("heading", { level: 2 })).toHaveCount(1);
    await expect(rail.getByRole("heading", { name: "本稿全部引用", exact: true })).toBeVisible();
    assert.equal(await page.locator(".studio-writing-main .studio-writing-assets").count(), 0);
    await expect(page.getByRole("group", { name: "备用标题", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "备用标题", exact: true })).toHaveCount(0);
    const titleBox = await page.getByRole("textbox", { name: "稿件标题", exact: true }).boundingBox();
    const alternatives = await page.getByRole("group", { name: "备用标题", exact: true }).boundingBox();
    const views = await page.getByRole("textbox", { name: "纯口播正文", exact: true }).boundingBox();
    assert.ok(titleBox && alternatives && views && titleBox.y + titleBox.height <= alternatives.y && alternatives.y + alternatives.height <= views.y);
    const bounds = await page.locator(".studio-writing-grid").boundingBox();
    assert.ok(bounds && bounds.y + bounds.height <= 900, JSON.stringify(bounds));
    assert.equal(await page.locator(".studio-writing-body textarea").evaluate(node => {
      const element = node as unknown as { scrollHeight: number; clientHeight: number }; return element.scrollHeight > element.clientHeight;
    }), true);
    const references = page.getByRole("region", { name: "引用内容列表", exact: true });
    assert.equal(await references.evaluate(node => {
      const element = node as unknown as { scrollHeight: number; clientHeight: number }; return element.scrollHeight > element.clientHeight;
    }), true);
    await references.evaluate(node => { (node as unknown as { scrollTop: number }).scrollTop = 200; });
    assert.ok(await references.evaluate(node => (node as unknown as { scrollTop: number }).scrollTop) > 0);
    assert.equal(await page.evaluate("scrollY"), 0);
    await page.screenshot({ path: ".impeccable/review/writing-screen-1440.png" });
    const markdown = page.getByRole("textbox", { name: "纯口播正文", exact: true });
    await markdown.focus(); await markdown.evaluate(node => (node as unknown as { setSelectionRange(start: number, end: number): void }).setSelectionRange(0, 8));
    await page.getByRole("button", { name: "AI 改稿", exact: true }).click();
    const revision = page.getByRole("dialog", { name: "AI 改稿", exact: true });
    await revision.getByRole("button", { name: "使用选中段落", exact: true }).click();
    await expect(revision).toContainText("选中：先固定角色参考图");
    await revision.getByRole("textbox", { name: "改稿要求", exact: true }).fill("只精炼这句话，保留条件。");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "AI 改稿", exact: true }).click();
    await expect(revision.getByRole("textbox", { name: "改稿要求", exact: true })).toHaveValue("只精炼这句话，保留条件。");
    await page.keyboard.press("Escape");
    for (const [button, title] of [["生成口播稿", "生成口播与制作方案"], ["写作依据", "写作依据与版本"], ["修改历史", "修改历史"], ["复制与导出", "复制与导出"]]) {
      await page.getByRole("button", { name: button!, exact: true }).click();
      await expect(page.getByRole("dialog", { name: title!, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    const body = await page.locator(".studio-writing-main").boundingBox(), refs = await rail.boundingBox();
    assert.ok(body && body.height <= 900); assert.ok(refs && refs.height <= 900);
    await page.screenshot({ path: ".impeccable/review/writing-screen-390.png", fullPage: true });
    await page.getByRole("button", { name: "AI 改稿", exact: true }).click();
    await expect(revision).toBeVisible();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await page.screenshot({ path: ".impeccable/review/writing-screen-dialog-390.png" });
    await page.keyboard.press("Escape");
    assert.deepEqual((await app.inject({ url: endpoint, headers })).json().content, content);
    assert.deepEqual(errors, []);
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
