import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("公众号手动任务在低内存和采集关闭时等待，恢复后沿用原ID保存正文", async () => {
  const fixture = await sourceResourceFixture();
  const { app, headers, capacity, host } = fixture;
  capacity.memoryBytes = 1024 ** 3;
  const url = "https://mp.weixin.qq.com/s/resource-memory-queue";
  const upstream = await stub((_hit, req) => req.url.includes("post_history") ? { code: 0, data: [{ position: 1,
    url, title: "口型同步操作更新", post_time: Math.floor(Date.now() / 1000), digest: "演示创作步骤", sn: "resource-memory" }], remain_money: 100 }
    : { code: 0, title: "口型同步操作更新", content: "<p>先对齐音轨，再检查口型。</p>", author: "创作教程", desc: "演示创作步骤" });
  const previousBase = process.env.DAJIALA_BASE_URL, previousKey = process.env.DAJIALA_KEY, previousEnabled = process.env.COLLECT_ENABLED;
  process.env.DAJIALA_BASE_URL = upstream.url; process.env.DAJIALA_KEY = "test-key";
  config.allowPrivateNetworkFetch = true;
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "resource-mp", name: "受控公众号", kind: "mp_account", participation_mode: "hot_signal", config: { ghid: "gh_resource_memory" } } })).statusCode, 200);
    const submitted = await app.inject({ method: "POST", url: "/api/admin/sources/resource-mp/fetch", headers });
    assert.equal(submitted.statusCode, 200);
    const id = submitted.json().jobId as string;
    assert.ok(id);
    const boss = await getBoss();
    await registerSourceJobs(boss);
    await fixture.warm();
    await delay(2200);
    assert.equal(upstream.hits(), 0, "手动操作不能绕过低内存保护");
    const [pending] = await boss.findJobs<{ reason: string }>(QUEUES.mpCheck, { id });
    assert.equal(pending!.state, "created");
    assert.equal(pending!.retryCount, 0);
    assert.equal(pending!.data.reason, "manual");
    const before = (await app.inject({ url: "/api/admin/sources/resource-mp", headers })).json();
    assert.equal(before.runs.length, 0);
    assert.equal(before.source.health, "unknown");
    assert.equal(before.source.fail_count, 0);
    assert.equal(before.source.last_ok_at, null);
    process.env.COLLECT_ENABLED = "false";
    capacity.memoryBytes = 4 * 1024 ** 3;
    for (let n = 0; n < 14; n++) host.sample();
    await delay(2200);
    assert.equal(upstream.hits(), 0, "采集开关关闭时仍保持待领取");
    assert.equal((await boss.findJobs(QUEUES.mpCheck, { id }))[0]!.state, "created");
    process.env.COLLECT_ENABLED = "true";
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && (await boss.findJobs(QUEUES.mpCheck, { id }))[0]!.state !== "completed") await delay(50);
    const [finished] = await boss.findJobs(QUEUES.mpCheck, { id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    assert.equal(upstream.hits(), 2);
    const detail = (await app.inject({ url: "/api/admin/sources/resource-mp", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    assert.equal(detail.items[0].title, "口型同步操作更新");
  } finally {
    await stopBoss(); await app.close(); await upstream.close();
    if (previousBase === undefined) delete process.env.DAJIALA_BASE_URL; else process.env.DAJIALA_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.DAJIALA_KEY; else process.env.DAJIALA_KEY = previousKey;
    if (previousEnabled === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = previousEnabled;
  }
});
