import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { gate, stub } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { topicAnalysisQueue, scheduleTopicMaterialAnalyses } from "../backend/topic-material-analysis.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
const entered = gate(), release = gate();
const provider = await stub(async () => { entered.open(); await release.promise; return {}; });
after(async () => { release.open(); await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("最后一次分析进程中断后按实际队列终态显示失败，读取和定时器不复活付费任务，显式重试可重新排队", { timeout: 20_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
    payload: { id: "analysis-recovery", name: "恢复测试", kind: "rss", config: { feedUrl: "https://analysis-recovery.example/feed" } } })).statusCode, 200);
  await upsertMaterial({ sourceId: "analysis-recovery", title: "角色控制", url: "https://analysis-recovery.example/one", via: "import",
    discoveredAt: new Date("2026-10-17T10:00:00Z"), bodyText: "保留角色参考。", bodyStatus: "ok" });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200);
  const url = `/api/admin/studio/topic-batches/${frozen.json().batch.id}/analysis`;
  config.modelCallsEnabled = true;
  const submitted = await app.inject({ method: "POST", url, headers, payload: {} });
  assert.equal(submitted.statusCode, 200); const id = submitted.json().jobId;
  const boss = await getBoss(), queue = topicAnalysisQueue.name;
  const [first] = await boss.fetch(queue); assert.equal(first!.id, id);
  await boss.fail(queue, id, { message: "first interrupted attempt" });
  const env: NodeJS.ProcessEnv = { ...process.env, LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "recovery-test-key", LLM_MODEL: "recovery-test-model", MODEL_CALLS_ENABLED: "true", ALLOW_PRIVATE_NETWORK_FETCH: "true" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    process.send({stage:'started'});
    await import('./tests/setup.ts');
    const {getBoss}=await import('@aihot/backend/jobs/queue');
    const {topicAnalysisQueue}=await import('./modules/studio/backend/topic-material-analysis.ts');
    const {installModules}=await import('@aihot/backend/modules');
    const {SERVER_MODULES}=await import('@aihot/site/modules/server');
    installModules(SERVER_MODULES);
    const boss=await getBoss();
    process.send({stage:'queue_ready'});
    const [job]=await boss.fetch(topicAnalysisQueue.name,{ignoreStartAfter:true,includeMetadata:true});
    process.send({stage:'fetched',found:!!job,retryCount:job?.retryCount});
    if(!job || job.retryCount!==1) process.exit(2);
    await topicAnalysisQueue.run([job.data]);
  `], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stage: unknown = null, stderr = "";
  child.on("message", message => { stage = message; });
  child.stderr!.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
  const exited = once(child, "exit");
  try {
    await Promise.race([entered.promise,
      exited.then(([code, signal]) => { throw new Error(`分析子进程提前退出：${JSON.stringify({ code, signal, stage, stderr })}`); }),
      delay(8000).then(() => { throw new Error(`分析子进程未到达本地模型：${JSON.stringify({ stage, stderr })}`); })]);
    assert.equal((await app.inject({ url, headers })).json().rows[0].state, "running");
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queuedCount, 0);
    child.kill(); await exited;
    // pg-boss expiry uses the same public fail transition after a worker disappears.
    await boss.fail(queue, id, { message: "last worker disappeared" });
    assert.equal((await boss.findJobs(queue, { id }))[0]!.state, "failed");
    const result = (await app.inject({ url, headers })).json();
    assert.equal(result.rows[0].state, "failed"); assert.ok(result.rows[0].error);
    assert.equal(result.analyzed, 0); assert.equal(result.pending, 1);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).json().queuedCount, 0);
    assert.equal((await scheduleTopicMaterialAnalyses()).queued, 0);
    const retried = await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } });
    assert.equal(retried.statusCode, 200); assert.equal(retried.json().queuedCount, 1);
    assert.notEqual(retried.json().jobId, id);
    assert.equal((await app.inject({ url, headers })).json().rows[0].state, "queued");
    // Retention or cancellation must not leave another unrecoverable queued record.
    await boss.cancel(queue, retried.json().jobId);
    assert.equal((await app.inject({ url, headers })).json().rows[0].state, "failed");
    const afterCancel = await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } });
    assert.equal(afterCancel.json().queuedCount, 1);
    await boss.deleteJob(queue, afterCancel.json().jobId);
    assert.equal((await app.inject({ url, headers })).json().rows[0].state, "failed");
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { retryFailed: true } })).json().queuedCount, 1);
    assert.equal(provider.hits(), 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } release.open(); }
});
