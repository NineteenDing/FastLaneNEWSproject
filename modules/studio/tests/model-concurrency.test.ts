import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { stub, gate } from "../../../tests/setup.ts";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ReceiptBusyError } from "@aihot/backend/providers/receipts";

after(async () => { await stopBoss(); await closeDb(); });

test("执行位全满时仍能立即复用已保存回答或识别原请求在途，不重复付费", { timeout: 15000 }, async () => {
  const release = gate(), entered = gate(); let held = 0;
  const provider = await stub(async (_hit, request) => {
    if (JSON.stringify(request.body).includes("hold-recovery")) {
      if (++held === 2) entered.open();
      await release.promise;
    }
    return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  });
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "local-recovery-key", LLM_MODEL: "receipt-slots-model" });
  const options = { model: "default", purpose: "receipt_slots", promptVersion: "receipt-slots-v1", system: "恢复已有请求", schema: z.object({ ok: z.literal(true) }), maxTokens: 512 };
  const saved = { ...options, user: "saved-answer", subject: "saved-answer" };
  const pending = { ...options, user: "hold-recovery-one", subject: "held-recovery-one" };
  const calls: Promise<unknown>[] = [];
  let inspection: Promise<unknown> | undefined;
  try {
    const first = await chatJson(saved);
    calls.push(chatJson(pending), chatJson({ ...options, user: "hold-recovery-two", subject: "held-recovery-two" }));
    for (const call of calls) void call.catch(() => {});
    await Promise.race([entered.promise, delay(4000).then(() => { throw new Error("两个请求未进入"); })]);
    const inspections = [
      chatJson(saved).then(result => { assert.equal(result.reused, true); assert.equal(result.receiptId, first.receiptId); }),
      assert.rejects(chatJson(pending), ReceiptBusyError),
    ];
    calls.push(...inspections);
    inspection = Promise.all(inspections);
    void inspection.catch(() => {});
    await Promise.race([inspection, delay(500).then(() => { throw new Error("读取已有回执不应等待服务商请求执行位"); })]);
    assert.equal(provider.hits(), 3, "复用及在途判断均未重发请求");
  } finally { release.open(); await Promise.allSettled(calls); await inspection?.catch(() => {}); await provider.close(); }
});

test("跨用途模型请求共用两个执行位，第三个在前两个完成前不发出请求", { timeout: 15000 }, async () => {
  const release = gate(), entered = gate(); let active = 0, peak = 0;
  const provider = await stub(async () => {
    active++; peak = Math.max(peak, active); if (active === 2) entered.open();
    try { await release.promise; return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }; }
    finally { active--; }
  });
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_API_KEY: "local-concurrency-key", LLM_MODEL: "local-concurrency-model" });
  const calls: Promise<unknown>[] = [];
  try {
    for (const purpose of ["studio_material_analysis", "studio_topic_review", "studio_writing_draft"]) calls.push(chatJson({
      model: "default", purpose, subject: purpose, promptVersion: "concurrency-v1", system: "本地并发测试", user: purpose,
      schema: z.object({ ok: z.literal(true) }), maxTokens: 512,
    }));
    await Promise.race([entered.promise, delay(4000).then(() => { throw new Error("两个可用执行位未开始请求"); })]);
    await delay(250); assert.equal(provider.hits(), 2, "第三个用途也必须等候共享执行位");
    release.open(); await Promise.all(calls); assert.equal(provider.hits(), 3); assert.equal(peak, 2);
  } finally { release.open(); await Promise.allSettled(calls); await provider.close(); }
});

test("等候共享执行位时网页暂停，尚未发出的创作请求不消耗预算或继续调用", { timeout: 15000 }, async () => {
  const { sourceResourceFixture } = await import("./source-resource-fixture.ts");
  const { studioChatJson } = await import("../backend/studio-model.ts");
  const { budgetStatus } = await import("@aihot/backend/providers/llm-budget");
  const resources = await sourceResourceFixture(), { app, headers } = resources;
  const release = gate(), entered = gate(); let active = 0;
  const provider = await stub(async () => {
    if (++active === 2) entered.open();
    await release.promise;
    return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  });
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_MODEL: "paused-slot-model", STUDIO_MATERIAL_ANALYSIS_MODEL: "default" });
  const options = { model: "default", purpose: "concurrency_pause", promptVersion: "pause-slots-v1", system: "等待执行位", user: "本地请求", schema: z.object({ ok: z.literal(true) }), maxTokens: 512 };
  const calls = [chatJson({ ...options, user: "第一个本地请求", subject: "held-one" }), chatJson({ ...options, user: "第二个本地请求", subject: "held-two" })];
  for (const call of calls) void call.catch(() => {});
  let waiting: Promise<unknown> | undefined;
  try {
    await Promise.race([entered.promise, delay(4000).then(() => { throw new Error("两个请求未进入"); })]);
    const before = budgetStatus();
    waiting = studioChatJson("studioMaterialAnalysis", { ...options, subject: "must-remain-waiting" });
    void waiting.catch(() => {});
    await delay(200); assert.equal(provider.hits(), 2);
    const state = (await app.inject({ url: "/api/admin/studio/model-operations", headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-operations", headers,
      payload: { version: state.version, enabled: false } })).statusCode, 200);
    release.open(); await Promise.all(calls);
    await assert.rejects(waiting, /模型调用已暂停/);
    assert.equal(provider.hits(), 2);
    assert.ok(budgetStatus().spentToday <= before.spentToday, "等待并暂停的请求没有产生新的预算预留");
  } finally {
    release.open(); await Promise.allSettled([...calls, ...(waiting ? [waiting] : [])]); await provider.close(); await app.close();
  }
});

test("另一个单连接池进程也共享两个执行位，完成后无需保持数据库连接", { timeout: 15000 }, async () => {
  const release = gate(), entered = gate(); let active = 0, peak = 0;
  const provider = await stub(async () => {
    active++; peak = Math.max(peak, active); if (active === 2) entered.open();
    try { await release.promise; return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }; }
    finally { active--; }
  });
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_MODEL: "process-slots-model" });
  const options = { model: "default", purpose: "process_slots", promptVersion: "process-slots-v1", system: "跨进程并发", schema: z.object({ ok: z.literal(true) }), maxTokens: 512 };
  const calls = [chatJson({ ...options, user: "parent-one", subject: "parent-one" }), chatJson({ ...options, user: "parent-two", subject: "parent-two" })];
  for (const call of calls) void call.catch(() => {});
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown[]> | undefined;
  try {
    await Promise.race([entered.promise, delay(4000).then(() => { throw new Error("父进程请求未进入"); })]);
    child = spawn(process.execPath, ["--input-type=module", "-e", `import{chatJson}from'@aihot/backend/providers/llm';import{closeDb}from'@aihot/backend/db';import{z}from'zod';
      process.send({type:'started'});await chatJson({model:'default',purpose:'process_slots',promptVersion:'process-slots-v1',system:'跨进程并发',user:'child',subject:'child',schema:z.object({ok:z.literal(true)}),maxTokens:512});
      await closeDb();process.disconnect();`], { windowsHide: true, env: { ...process.env, DATABASE_POOL_MAX: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.resume(); exited = once(child, "exit");
    await once(child, "message"); await delay(300);
    assert.equal(provider.hits(), 2, "独立进程不能新放行另一份额度");
    release.open(); await Promise.all(calls); assert.deepEqual(await exited, [0, null]);
    assert.equal(provider.hits(), 3); assert.equal(peak, 2);
  } finally {
    release.open(); await Promise.allSettled(calls);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await provider.close();
  }
});

test("领取执行位的数据库等待消耗同一请求截止，迟到的领取不能重新发起HTTP", { timeout: 10000 }, async () => {
  const release = gate(), locked = gate();
  const blocker = sql.begin(async db => { await db`LOCK TABLE module_queue_execution_leases IN ACCESS EXCLUSIVE MODE`; locked.open(); await release.promise; });
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
  Object.assign(process.env, { LLM_BASE_URL: provider.url + "/v1", LLM_MODEL: "late-claim-model" });
  let pending: Promise<unknown> | undefined;
  try {
    await locked.promise;
    pending = chatJson({ model: "default", purpose: "late_claim", subject: "late-claim", promptVersion: "late-claim-v1",
      system: "迟到领取", user: "领取截止后不发出请求", schema: z.object({ ok: z.literal(true) }), timeoutMs: 50, maxTokens: 512 });
    void pending.catch(() => {});
    await delay(150); release.open(); await blocker;
    await assert.rejects(pending, /deadline|Timeout/i);
    assert.equal(provider.hits(), 0, "领取耗时不能被提交后的新计时器抹掉");
  } finally { release.open(); await blocker; await pending?.catch(() => {}); await provider.close(); }
});
