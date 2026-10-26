import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("足量长标题来源在列表内滚动，翻页始终在本屏，指定设置无需展开", async () => {
  for (let index = 0; index < 30; index++) {
    const result = await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: `screen-source-${index}`, name: `单屏验收${index}：角色一致性与镜头衔接的长名称资料来源`, kind: "rss", enabled: false,
        config: { feedUrl: `https://example.com/screen-${index}.xml` } } });
    assert.equal(result.statusCode, 200, result.body);
  }
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(web.origin + "/admin/studio/following?q=screen-source");
    await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    const pagination = page.getByRole("navigation", { name: "新闻源分页", exact: true });
    await expect(page.getByRole("article")).toHaveCount(24);
    const bounds = await pagination.boundingBox(); assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900);
    assert.equal(await page.locator(".studio-page-content").evaluate(node => { const element = node as unknown as { scrollHeight: number; clientHeight: number }; return element.scrollHeight > element.clientHeight; }), true);
    await pagination.getByRole("link", { name: "下一页", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(6);
    for (const [section, heading] of [["models", "兼容服务与费用估算"], ["collection", "采集与转写组件"], ["learning", "栏目规则学习"], ["backup", "备份状态与操作"]]) {
      await page.goto(web.origin + `/admin/studio/settings/${section}`);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: heading, exact: true }).locator("xpath=ancestor::details")).toHaveCount(0);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["following", "creators", "intelligence", "writing", "settings/learning", "settings/trends"]) {
        await page.goto(web.origin + "/admin/studio/" + route);
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, `${width}/${route}`);
      }
    }
  } finally { await browser.close(); await web.stop(); }
});
