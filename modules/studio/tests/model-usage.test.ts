import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { budgetStatus } from "@aihot/backend/providers/llm-budget";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { stub } from "../../../tests/setup.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("复用已保存模型回执不新增请求，也不重复累计人民币预算", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "local-usage-key", LLM_MODEL: "usage-model" });
  const options = { model: "default", purpose: "studio_writing_draft", subject: "usage-reuse", promptVersion: "usage-v1",
    system: "口播测试", user: "保存成功的答案可以复用", schema: z.object({ ok: z.literal(true) }), maxTokens: 2000 };
  try {
    const first = await chatJson(options), afterFirst = budgetStatus();
    assert.equal(first.reused, false); assert.equal(provider.hits(), 1);
    const second = await chatJson(options); assert.equal(second.reused, true); assert.equal(second.receiptId, first.receiptId);
    assert.equal(provider.hits(), 1);
    assert.equal(budgetStatus().spentToday, afterFirst.spentToday, "未产生第二次付费请求，不应再次登记费用");
    assert.equal(budgetStatus().spentThisMonth, afterFirst.spentThisMonth);
  } finally { await provider.close(); }
});

test("费用与用量只向登录用户展示，按用途汇总已有回执和估算而不再次调用模型", async () => {
  const { sourceResourceFixture } = await import("./source-resource-fixture.ts");
  const { app, headers } = await sourceResourceFixture();
  try {
    const url = "/api/admin/studio/model-usage", response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ url })).statusCode, 401);
    const report = response.json(); assert.equal(report.timeZone, "Asia/Hong_Kong"); assert.equal(report.currency, "CNY");
    assert.deepEqual(report.concurrency, { limit: 2, occupied: 0 });
    assert.equal(report.budget.spentToday, budgetStatus().spentToday);
    assert.equal(report.rows.length, 6);
    const writing = report.rows.find((row: { key: string }) => row.key === "writing");
    assert.equal(writing.attemptsThisMonth, 1); assert.equal(writing.inputTokensThisMonth, 1000); assert.equal(writing.outputTokensThisMonth, 1000);
    assert.equal(writing.estimatedToday, report.budget.spentToday); assert.equal(writing.reservedToday, 0);
    for (const privateValue of ["local-usage-key", "usage-reuse", "保存成功的答案可以复用", "ledger.jsonl"])
      assert.ok(!response.body.includes(privateValue));
  } finally { await app.close(); }
});

test("费用估算中的缓存输入只计算一次", async () => {
  const options = { model: "usage-connection", purpose: "studio_topic_review", subject: "cache-usage", promptVersion: "cache-usage-v1",
    system: "估算输入", user: "缓存输入不重复", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000 };
  const response = (usage: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage }), { status: 200 });
  const connection = { service: "llm", model: "cache-usage-model", identity: "cache-usage-v1", jsonMode: true,
    price: { inputPerMillion: 2, outputPerMillion: 8 }, request: async () => response({ prompt_tokens: 1000, prompt_cache_hit_tokens: 400, completion_tokens: 1000 }) };
  const before = budgetStatus().spentToday;
  await chatJson({ ...options, connection });
  assert.ok(Math.abs(budgetStatus().spentToday - before - 0.01) < 1e-10, "1000总输入和1000输出按2/8元计，共0.01元");
});

test("服务商未报告完整用量时保留预算，不能当作免费请求", async () => {
  const before = budgetStatus().spentToday;
  await chatJson({ model: "missing-usage", purpose: "studio_topic_review", subject: "missing-usage", promptVersion: "missing-v1",
    system: "保留预算", user: "服务商未报告用量", schema: z.object({ ok: z.literal(true) }), maxTokens: 1000,
    connection: { service: "llm", model: "missing-usage-model", identity: "missing-usage-v1", jsonMode: true,
      price: { inputPerMillion: 2, outputPerMillion: 8 }, request: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }], usage: {},
      }), { status: 200 }) } });
  assert.ok(budgetStatus().spentToday > before, "缺少用量时保留原预算预留，不能当作零消耗");
});
