import { gate, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("空闲来源队列退出不会提前释放仍在处理公众号的监测，排空后允许重新接管", async () => {
  const fixture = await sourceResourceFixture();
  const { app, headers, host, admission } = fixture;
  const entered = gate(), release = gate();
  const upstream = await stub(async () => { entered.open(); await release.promise; return { code: 0, data: [], remain_money: 100 }; });
  const previousBase = process.env.DAJIALA_BASE_URL, previousKey = process.env.DAJIALA_KEY;
  process.env.DAJIALA_BASE_URL = upstream.url; process.env.DAJIALA_KEY = "test-key";
  config.allowPrivateNetworkFetch = true;
  let stopping: Promise<void> | undefined;
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "resource-drain-mp", name: "排空验证公众号", kind: "mp_account", participation_mode: "hot_signal", config: { ghid: "gh_resource_drain" } } })).statusCode, 200);
    const submitted = await app.inject({ method: "POST", url: "/api/admin/sources/resource-drain-mp/fetch", headers });
    assert.equal(submitted.statusCode, 200);
    const id = submitted.json().jobId as string;
    assert.ok(id);
    const boss = await getBoss();
    await registerSourceJobs(boss);
    await fixture.warm();
    await Promise.race([entered.promise, delay(4500).then(() => { throw new Error("本地公众号请求未启动"); })]);
    stopping = stopBoss({ timeoutMs: 8000 });
    await delay(100);
    assert.equal(host.status().state, "ready", "已有任务尚未安全完成时监测必须保持有效");
    assert.throws(() => admission(), /活动消费者/, "其他消费者不能抢占正在排空的监测");
    release.open();
    await stopping;
    assert.equal(host.status().state, "unavailable");
    const nextOwner = admission();
    try { assert.equal(nextOwner.canStart(), false, "重新接管仍需预热，不能复用旧准入"); }
    finally { nextOwner.stop(); }
    const detail = (await app.inject({ url: "/api/admin/sources/resource-drain-mp", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    const restarted = await getBoss();
    const [finished] = await restarted.findJobs(QUEUES.mpCheck, { id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
  } finally {
    release.open();
    await stopping;
    await stopBoss(); await app.close(); await upstream.close();
    if (previousBase === undefined) delete process.env.DAJIALA_BASE_URL; else process.env.DAJIALA_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.DAJIALA_KEY; else process.env.DAJIALA_KEY = previousKey;
  }
});
