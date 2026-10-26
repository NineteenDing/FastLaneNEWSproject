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
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("FL主题保留公开和五工作页，首次深色、浅色与系统选择可保存，三个尺寸不横溢", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/acceptance-examples", headers, payload: {} })).statusCode, 200);
  const drafts = (await app.inject({ url: "/api/admin/studio/drafts", headers })).json().rows;
  const web = await startWebServer(app.server), browser = await chromium.launch();
  const context = await browser.newContext({ colorScheme: "light", reducedMotion: "reduce" });
  const [name, ...value] = headers.cookie.split("=");
  await context.addCookies([{ name: name!, value: value.join("="), url: web.origin }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir(".impeccable/review", { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(web.origin + "/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "深色", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "浅色", exact: true }).click();
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("radio", { name: "跟随系统", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" }); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload(); await expect(page.getByRole("radio", { name: "跟随系统", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.emulateMedia({ colorScheme: "light" }); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const routes = ["/", "/film/domestic", "/admin/studio/following", "/admin/studio/intelligence", "/admin/studio/topics", "/admin/studio/writing", `/admin/studio/writing/${drafts[0].id}`, "/admin/studio/settings"];
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["dark", "light"] as const) {
        await page.goto(web.origin + "/admin/studio/following");
        await page.getByRole("radio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
        for (const route of routes) {
          const response = await page.goto(web.origin + route);
          assert.equal(response?.status(), 200, route);
          await page.evaluate("document.fonts.ready");
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, `${width}/${theme}/${route}`);
          const brand = page.locator(".fl-wordmark:visible").first();
          if (await brand.count()) {
            await expect(brand).toHaveAttribute("aria-label", "FastLaneNEWS");
            assert.equal(await page.evaluate("(() => { const el = [...document.querySelectorAll('.fl-wordmark')].find(el => el.getClientRects().length); const p = el.parentElement.getBoundingClientRect(), b = el.getBoundingClientRect(); return b.right <= p.right + 1; })()"), true, "品牌标完整留在父区域内");
            assert.equal(await page.evaluate("[...document.querySelectorAll('.fl-wordmark img')].find(el => el.getClientRects().length).naturalWidth > 0"), true);
          }
          if (width > 960 && route === "/") {
            const contrast = Number(await page.evaluate(`(() => {
              const el = document.querySelectorAll('.fl-rail nav a')[1];
              const rgb = text => text.match(/[\\d.]+/g).slice(0, 3).map(Number);
              const luminance = values => values.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
              const ink = luminance(rgb(getComputedStyle(el).color)), paper = luminance(rgb(getComputedStyle(el.closest(".fl-rail")).backgroundColor));
              return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
            })()`));
            assert.ok(contrast >= 4.5, `暖纸导航文字对比${contrast}`);
          }
          if (route === "/" || route.includes(`/writing/${drafts[0].id}`)) {
            if (route !== "/" && width === 1024) {
              assert.ok((await page.locator(".studio-writing-body").boundingBox())!.height >= 200, "小桌面正文不能被标题和素材挤成细条");
            }
            if (route !== "/" && width <= 1100) {
              const visible = Number(await page.evaluate(`(() => {
                const el = document.querySelector('.studio-writing-drafts li a');
                const link = el.getBoundingClientRect(), list = el.closest("ul").getBoundingClientRect();
                return Math.min(link.bottom, list.bottom) - Math.max(link.top, list.top);
              })()`));
              assert.ok(visible >= 44, "至少一条稿件完整露出可点击区域，导航说明不挤占列表");
            }
            await page.screenshot({ path: `.impeccable/review/phase2-brand-${route === "/" ? "public" : "writing"}-${width}-${theme}.png`, fullPage: true });
          }
        }
      }
    }
    await page.goto(web.origin + "/admin/studio/following");
    await page.getByRole("radio", { name: "深色", exact: true }).focus();
    assert.equal(await page.evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none'"), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await web.stop(); }
});
