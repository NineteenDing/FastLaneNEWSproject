import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";
const { app, headers } = await sourceResourceFixture();
let providerCalls = 0;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("网页预算立即影响实际模型发送、跨进程共用且不清空用量，零上限仍可复用已有回执", async t => {
  const path = "/api/admin/studio/model-budget";
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const first = await app.inject({ url: path, headers }); assert.equal(first.statusCode, 200);
  assert.equal(first.json().version, 0); assert.equal(first.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "PUT", url: path, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  const save = (version: number, perDay: number, perMonth: number) => app.inject({ method: "PUT", url: path, headers, payload: { version, perDay, perMonth } });
  const stopped = await save(0, 0, 0); assert.equal(stopped.statusCode, 200, stopped.body); assert.equal(stopped.json().version, 1);
  const provider = await stub(() => { providerCalls++; return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }; });
  t.after(() => provider.close());
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-budget-key", LLM_MODEL: "isolated-budget-model" });
  const options = { model: "default", purpose: "studio_writing_draft", subject: "saved-budget-answer", promptVersion: "budget-settings-v1",
    system: "保留预算", user: "预算设置不会重新计费", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000 };
  await assert.rejects(chatJson({ ...options, subject: "blocked-at-zero" }), /budget/i); assert.equal(provider.hits(), 0);
  assert.equal((await save(1, 2, 50)).statusCode, 200);
  const result = await chatJson(options); assert.equal(result.reused, false); assert.equal(provider.hits(), 1);
  const usage = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
  assert.equal(usage.budget.perDay, 2); assert.equal(usage.budget.perMonth, 50); assert.ok(usage.budget.spentToday > 0);
  assert.equal((await save(2, 100, 0)).statusCode, 200);
  await assert.rejects(chatJson({ ...options, subject: "blocked-by-month", user: "月上限阻止新的请求" }), /monthly budget/i); assert.equal(provider.hits(), 1);
  const reused = await chatJson(options); assert.equal(reused.reused, true); assert.equal(reused.receiptId, result.receiptId); assert.equal(provider.hits(), 1);
  const after = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
  assert.equal(after.budget.spentToday, usage.budget.spentToday); assert.equal(after.budget.spentThisMonth, usage.budget.spentThisMonth);
  assert.equal((await save(3, 0, 100)).statusCode, 200);
  const child = await promisify(execFile)(process.execPath, ["modules/studio/tests/model-budget-child.ts"], { cwd: process.cwd(), env: process.env, timeout: 15000 });
  assert.deepEqual(JSON.parse(child.stdout.trim()), { blocked: true, perDay: 0, perMonth: 100 }); assert.equal(provider.hits(), 1);
  assert.equal((await save(2, 10, 100)).statusCode, 409);
  for (const value of [-1, 1000001, null, "2"])
    assert.equal((await app.inject({ method: "PUT", url: path, headers, payload: { version: 4, perDay: value, perMonth: 100 } })).statusCode, 400);
  const current = (await app.inject({ url: path, headers })).json();
  assert.equal(current.version, 4); assert.equal(current.perDay, 0); assert.equal(current.perMonth, 100);
  assert.ok(!JSON.stringify(current).includes("isolated-budget-key"));
});

test("保存的预算文件损坏时停止新请求，恢复配置后原用量与版本仍可读取", async () => {
  const file = path.join(config.dataDir, "llm-budget", "limits.json"), before = await readFile(file, "utf8"), calls = providerCalls;
  const read = () => app.inject({ url: "/api/admin/studio/model-budget", headers });
  try {
    await writeFile(file, '{"format":1,"perDay":1000000}');
    assert.equal((await read()).statusCode, 500);
    await assert.rejects(chatJson({ model: "default", purpose: "studio_writing_draft", subject: "corrupt-budget", promptVersion: "corrupt-budget-v1",
      system: "预算校验", user: "损坏配置不能退回较高的默认值", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000 }), /预算配置/);
    assert.equal(providerCalls, calls);
  } finally { await writeFile(file, before); }
  assert.equal((await read()).json().version, 4);
});

test("设置页保存和冲突恢复预算不丢未保存Key，桌面窄屏只读和编辑不调用模型", async () => {
  const web = await startWebServer(app.server), browser = await chromium.launch(), calls = providerCalls;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/settings"); await page.locator('input[name="password"]').fill("source-resource-password");
    await page.locator('button[type="submit"]').click();
    await page.getByLabel("API Key", { exact: true }).fill("local-unsaved-key");
    const form = page.getByRole("form", { name: "模型预算设置", exact: true });
    await form.getByLabel("每日上限（元）", { exact: true }).fill("5.25"); await form.getByLabel("每月上限（元）", { exact: true }).fill("80");
    await form.getByRole("button", { name: "保存费用设置", exact: true }).click();
    await expect(form.getByRole("button", { name: "保存费用设置", exact: true })).toBeEnabled();
    await expect(form.getByLabel("每日上限（元）", { exact: true })).toHaveValue("5.25");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("local-unsaved-key");
    const saved = (await app.inject({ url: "/api/admin/studio/model-budget", headers })).json(); assert.equal(saved.version, 5); assert.equal(saved.perMonth, 80);
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-budget", headers,
      payload: { version: 5, perDay: 6, perMonth: 90 } })).statusCode, 200);
    await form.getByLabel("每日上限（元）", { exact: true }).fill("9"); await form.getByRole("button", { name: "保存费用设置", exact: true }).click();
    await expect(page.getByText("模型预算已在其他窗口修改，请刷新后重试", { exact: true })).toBeVisible();
    await expect(form.getByLabel("每日上限（元）", { exact: true })).toHaveValue("9");
    page.once("dialog", dialog => dialog.accept()); await form.getByRole("button", { name: "刷新预算设置", exact: true }).click();
    await expect(form.getByLabel("每日上限（元）", { exact: true })).toHaveValue("6");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("local-unsaved-key");
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await form.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await form.screenshot({ path: `.impeccable/review/model-budget-${suffix}.png` });
    }
    assert.equal(providerCalls, calls);
  } finally { await browser.close(); await web.stop(); }
});

test("费用提醒超过阈值仍允许发送，只有显式开启硬预算才拦截，旧回执始终可复用", async t => {
  const endpoint = "/api/admin/studio/model-budget", current = (await app.inject({ url: endpoint, headers })).json();
  const policy = { perDay: 0, perMonth: 0, hardLimitEnabled: false, warningPerDay: 0.0001, warningPerMonth: 0.0001 };
  const saved = await app.inject({ method: "PUT", url: endpoint, headers, payload: { version: current.version, ...policy } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().hardLimitEnabled, false);
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
  t.after(() => provider.close());
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "isolated-soft-budget-key", LLM_MODEL: "deepseek-flash" });
  const options = { model: "default", purpose: "studio_writing_draft", subject: "phase2-soft-budget-answer", promptVersion: "phase2-soft-budget-v1",
    system: "提醒不是硬停机", user: "超过费用提醒仍处理用户稿件", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000 };
  const result = await chatJson(options); assert.equal(result.reused, false); assert.equal(provider.hits(), 1);
  const usage = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
  assert.equal(usage.budget.hardLimitEnabled, false);
  assert.equal(usage.budget.warningToday, true); assert.equal(usage.budget.warningThisMonth, true);
  const stopped = await app.inject({ method: "PUT", url: endpoint, headers,
    payload: { version: saved.json().version, ...policy, hardLimitEnabled: true } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  await assert.rejects(chatJson({ ...options, subject: "phase2-explicit-hard-cap", user: "新请求必须遵守明确开启的硬预算" }), /budget/i);
  const reused = await chatJson(options); assert.equal(reused.receiptId, result.receiptId); assert.equal(reused.reused, true);
  assert.equal(provider.hits(), 1);
  const after = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
  assert.equal(after.budget.spentThisMonth, usage.budget.spentThisMonth);
});

test("全新配置默认只提醒10元和200元，不启用硬预算，独立进程保留同一实际预留账本", async () => {
  await mkdir(config.dataDir, { recursive: true });
  const directory = await mkdtemp(path.join(config.dataDir, "phase2-fresh-budget-"));
  try {
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import {modelBudgetLimits,reserveBudget,budgetStatus} from '@aihot/backend/providers/llm-budget';
      const initial=modelBudgetLimits();
      const reservation=reserveBudget({model:'deepseek-flash',purpose:'test-only-reservation',promptChars:50000000,maxTokens:100});
      console.log(JSON.stringify({initial,accepted:reservation.ok,after:budgetStatus()}));
    `], { cwd: process.cwd(), env: { ...process.env, AIHOT_DATA_DIR: directory, LLM_BUDGET_CNY_PER_DAY: undefined, LLM_BUDGET_CNY_PER_MONTH: undefined }, timeout: 15000 });
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.initial.hardLimitEnabled, false);
    assert.equal(result.initial.warningPerDay, 10); assert.equal(result.initial.warningPerMonth, 200);
    assert.equal(result.accepted, true); assert.equal(result.after.warningToday, true);
    assert.ok(result.after.spentToday > 10);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(config.dataDir) + path.sep));
    await rm(directory, { recursive: true });
  }
});

test("一期已保存的硬上限不会被二期升级静默关闭，也不重置已有费用", async () => {
  const file = path.join(config.dataDir, "llm-budget", "limits.json"), original = await readFile(file, "utf8");
  const endpoint = "/api/admin/studio/model-budget";
  const before = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json().budget.spentThisMonth;
  try {
    await writeFile(file, JSON.stringify({ format: 1, version: 50, perDay: 0, perMonth: 200, updatedAt: new Date().toISOString() }));
    const legacy = (await app.inject({ url: endpoint, headers })).json();
    assert.equal(legacy.hardLimitEnabled, true); assert.equal(legacy.perDay, 0); assert.equal(legacy.version, 50);
    const after = (await app.inject({ url: "/api/admin/studio/model-usage", headers })).json();
    assert.equal(after.budget.spentThisMonth, before);
  } finally { await writeFile(file, original); }
});
