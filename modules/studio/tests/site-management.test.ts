import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { forwardFeedbackToFeishu } from "@aihot/backend/notify/feishu";
import sharp from "sharp";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("站点资料使用管理员版本保存，公开只返回已发布日志，旧版本不能覆盖", async () => {
  const url = "/api/admin/studio/site-management";
  assert.equal((await app.inject({ url })).statusCode, 401);
  const initial = await app.inject({ url, headers }); assert.equal(initial.statusCode, 200);
  const before = initial.json(); assert.equal(before.version, 0);
  const about = { ...before.about, title: "少折腾，多出片。", paragraphs: ["只整理有出处的AI影视变化。"] };
  const releases = [{ id: "00000000-0000-4000-8000-000000000001", date: "2026-10-20", time: "12:00", kind: "更新", title: "公开站上线", body: ["新增日报和影视榜。"], published: true },
    { id: "00000000-0000-4000-8000-000000000002", date: "2026-10-21", time: "12:00", kind: "公告", title: "尚未发布的内部计划", body: ["不能公开的草案文字。"], published: false }];
  const payload = { version: before.version, about, releases };
  assert.equal((await app.inject({ method: "PUT", url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  const saved = await app.inject({ method: "PUT", url, headers, payload }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().version, 1);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 409);
  const profile = await app.inject({ url: "/api/site/about" }); assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().title, about.title); assert.deepEqual(profile.json().paragraphs, about.paragraphs);
  assert.deepEqual(profile.json().codes.map((row: { label: string }) => row.label), ["B站", "视频号", "抖音", "企业微信客服"]);
  const log = await app.inject({ url: "/api/site/changelog" }); assert.equal(log.statusCode, 200);
  assert.deepEqual(log.json().releases.map((row: { title: string }) => row.title), ["公开站上线"]);
  assert.equal(log.json().latestVersion, "2026-10-20T12:00"); assert.ok(!log.body.includes("草案"));
  assert.equal((await app.inject({ url: "/api/site/meta" })).json().changelogVersion, "2026-10-20T12:00");
});

test("访客截图留在私有本地，旧飞书开关误启也不转发本站反馈", async () => {
  const names = ["FEISHU_INTERNAL_ENABLED", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_INTERNAL_CHAT_ID"] as const;
  const before = names.map(name => process.env[name]), fetchBefore = globalThis.fetch;
  let outbound = 0;
  for (const [i, name] of names.entries()) process.env[name] = ["true", "site-test-app", "site-test-secret", "site-test-chat"][i];
  globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith("https://open.feishu.cn/")) return fetchBefore(input, init);
    outbound++; return Response.json(String(input).includes("tenant_access_token") ? { code: 0, tenant_access_token: "site-token", expire: 7200 } : { code: 0, data: { image_key: "site-image" } });
  }) as typeof fetch;
  try {
    const form = new FormData(); form.set("content", "公开站图片看不清，请检查显示。");
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
    form.set("screenshot", new Blob([new Uint8Array(png)], { type: "image/png" }), "shot.png");
    const request = new Request("http://localhost/api/site/feedback", { method: "POST", body: form });
    const submitted = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": "203.0.113.59" }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(submitted.statusCode, 201, submitted.body);
    assert.equal(await forwardFeedbackToFeishu(submitted.json().id), "disabled");
    const rows = (await app.inject({ url: "/api/admin/feedback", headers })).json().rows;
    assert.equal(rows.find((row: { id: number }) => row.id === submitted.json().id).screenshot, "local");
    assert.equal(outbound, 0, "不请求飞书token、上传或发送接口");
  } finally { globalThis.fetch = fetchBefore; names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }); }
});

test("站点管理真实网页能改介绍、发布日志、切换榜单与处理反馈，公开四码和免责声明可读", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts"), { mkdir } = await import("node:fs/promises");
  const web = await startWebServer(app.server), browser = await chromium.launch(), context = await browser.newContext({ reducedMotion: "reduce" });
  const [name, ...value] = headers.cookie.split("="); await context.addCookies([{ name: name!, value: value.join("="), url: web.origin }]);
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await mkdir(".impeccable/review", { recursive: true });
  try {
    await page.goto(web.origin + "/admin/studio/settings/site");
    await expect(page.getByRole("heading", { name: "关于资料", exact: true })).toBeVisible();
    const subtitle = "https://" + "FilmCreator".repeat(40), releaseTitle = "Release" + "X".repeat(170);
    await page.getByLabel("一句话介绍", { exact: true }).fill(subtitle);
    const intro = page.getByLabel("工作室介绍（空行分段）");
    await intro.fill("第一段介绍。"); await intro.press("End"); await intro.press("Enter"); await intro.press("Enter"); await intro.pressSequentially("第二段介绍。");
    await expect(intro).toHaveValue("第一段介绍。\n\n第二段介绍。");
    await page.screenshot({ path: ".impeccable/review/phase2-site-about-edit-1440.png", fullPage: true });
    await page.getByRole("button", { name: "保存关于资料", exact: true }).click();
    await expect.poll(async () => (await app.inject({ url: "/api/site/about" })).json().subtitle).toBe(subtitle);
    assert.deepEqual((await app.inject({ url: "/api/site/about" })).json().paragraphs, ["第一段介绍。", "第二段介绍。"]);
    const nav = page.getByRole("navigation", { name: "站点管理分类" });
    await nav.getByRole("link", { name: "更新日志", exact: true }).click();
    await page.getByRole("button", { name: /公开站上线/ }).click();
    await page.getByLabel("日志标题", { exact: true }).fill(releaseTitle);
    await page.getByRole("button", { name: "保存日志", exact: true }).click();
    await expect.poll(async () => (await app.inject({ url: "/api/site/changelog" })).json().releases[0]?.title).toBe(releaseTitle);
    await expect(page.getByLabel("日志标题", { exact: true })).toHaveCount(0);
    const countBeforeNew = (await app.inject({ url: "/api/admin/studio/site-management", headers })).json().releases.length;
    await page.getByRole("button", { name: "新建日志", exact: true }).click();
    await page.getByLabel("日志标题", { exact: true }).fill("准备取消的日志");
    page.once("dialog", d => void d.accept());
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(page.getByLabel("日志标题", { exact: true })).toHaveCount(0);
    assert.equal((await app.inject({ url: "/api/admin/studio/site-management", headers })).json().releases.length, countBeforeNew);
    await page.getByRole("button", { name: "新建日志", exact: true }).click();
    await page.getByLabel("日志标题", { exact: true }).fill("测试保存再删除");
    await page.getByRole("button", { name: "保存日志", exact: true }).click();
    await expect(page.getByRole("button", { name: /测试保存再删除/ })).toBeVisible();
    await page.getByRole("button", { name: /测试保存再删除/ }).click();
    page.once("dialog", d => void d.accept());
    await page.getByRole("button", { name: "删除日志", exact: true }).click();
    await expect(page.getByRole("button", { name: /测试保存再删除/ })).toHaveCount(0);
    assert.equal((await app.inject({ url: "/api/admin/studio/site-management", headers })).json().releases.length, countBeforeNew);
    await nav.getByRole("link", { name: "公开内容与榜单", exact: true }).click();
    const first = (await app.inject({ url: "/api/admin/studio/film-boards", headers })).json().boards[0];
    const control = page.getByRole("switch", { name: `${first.name}采集开关`, exact: true });
    await control.click(); await expect(control).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await app.inject({ url: "/api/admin/studio/film-boards", headers })).json().boards[0].enabled).toBe(false);
    await nav.getByRole("link", { name: "访客反馈", exact: true }).click();
    const feedback = (await app.inject({ url: "/api/admin/feedback", headers })).json().rows[0];
    await page.getByLabel(`反馈${feedback.id}处理状态`, { exact: true }).selectOption("resolved");
    await page.getByLabel(`反馈${feedback.id}内部备注`, { exact: true }).fill("已调整显示");
    await page.getByRole("button", { name: "保存处理", exact: true }).click();
    await expect.poll(async () => (await app.inject({ url: "/api/admin/feedback", headers })).json().rows[0].status).toBe("resolved");
    assert.equal((await app.inject({ url: `/api/admin/feedback/${feedback.id}/screenshot` })).statusCode, 401);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["dark", "light"]) {
        await page.goto(web.origin + "/admin/studio/settings/site");
        await page.getByRole("radio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
        await page.goto(web.origin + "/about");
        await expect(page.getByRole("heading", { name: "少折腾，多出片。", exact: true })).toBeVisible();
        for (const label of ["B站", "视频号", "抖音", "企业微信客服"]) await expect(page.getByRole("img", { name: `${label}二维码`, exact: true })).toBeVisible();
        assert.equal(await page.evaluate("[...document.querySelectorAll('img[alt$=\"二维码\"]')].every(el => el.complete && el.naturalWidth > 0)"), true);
        await expect(page.getByRole("link", { name: "反馈页", exact: true })).toHaveAttribute("href", "/feedback");
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
        await page.screenshot({ path: `.impeccable/review/phase2-site-about-${width}-${theme}.png`, fullPage: true });
        await page.goto(web.origin + "/changelog");
        await expect(page.getByRole("heading", { name: releaseTitle, exact: true })).toBeVisible();
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, "长连续英文日志标题不溢出");
        await page.goto(web.origin + "/admin/studio/settings/site?panel=feedback");
        assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
        await page.screenshot({ path: `.impeccable/review/phase2-site-settings-${width}-${theme}.png`, fullPage: true });
      }
    }
    const publicAbout = await app.inject({ url: "/api/site/about" }); assert.ok(!publicAbout.body.includes("已调整显示"));
    const log = await app.inject({ url: "/api/site/changelog" }); assert.ok(!log.body.includes("草案"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await web.stop(); }
});

test("反馈服务端拒绝超过5MiB的真实截图，不写入反馈或素材", async () => {
  const before = (await app.inject({ url: "/api/admin/feedback", headers })).json().rows.length;
  const pixels = Buffer.alloc(1500 * 1500 * 3, 137);
  const png = await sharp(pixels, { raw: { width: 1500, height: 1500, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(png.length > 5 * 1024 * 1024 && png.length < 8 * 1024 * 1024);
  const form = new FormData(); form.set("content", "验证服务端图片大小限制");
  form.set("screenshot", new Blob([new Uint8Array(png)], { type: "image/png" }), "large.png");
  const request = new Request("http://localhost/api/site/feedback", { method: "POST", body: form });
  const response = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": "203.0.113.60" }, payload: Buffer.from(await request.arrayBuffer()) });
  assert.equal(response.statusCode, 400, response.body); assert.match(response.json().detail, /5MB/);
  assert.equal((await app.inject({ url: "/api/admin/feedback", headers })).json().rows.length, before);
});
