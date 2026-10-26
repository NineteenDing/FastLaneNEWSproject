import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { enqueue, getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { collectSource } from "@aihot/backend/sources/collect";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("X分片在数据库容量保护时保持原任务和来源状态，恢复后收录新帖子", async () => {
  const fixture = await sourceResourceFixture();
  const { app, headers, capacity, database } = fixture;
  capacity.databaseBytes = 6 * 1024 ** 3;
  const base = BigInt(Date.now()) * 1000n;
  const upstream = await stub(hit => ({ tweets: [{ id_str: String(base + BigInt(hit)),
    tweet_created_at: new Date().toISOString(), full_text: hit === 1 ? "原有镜头演示" : "新发布的镜头控制步骤",
    lang: "zh", user: { name: "镜头创作者", screen_name: "resourcecreator" } }], next_cursor: null }));
  const previousBase = process.env.SOCIALDATA_BASE_URL, previousKey = process.env.SOCIALDATA_API_KEY;
  process.env.SOCIALDATA_BASE_URL = upstream.url; process.env.SOCIALDATA_API_KEY = "test-key";
  config.allowPrivateNetworkFetch = true;
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "resource-x", name: "受控X来源", kind: "x_search", participation_mode: "hot_signal",
        config: { query: "from:resourcecreator -filter:replies", searchType: "Latest" } } })).statusCode, 200);
    // Initialize coverage through the original public collector, using only the local provider.
    assert.equal((await collectSource("resource-x", { force: true })).status, "ok");
    const before = (await app.inject({ url: "/api/admin/sources/resource-x", headers })).json();
    const id = await enqueue(QUEUES.fetchXShard, { key: "resource-x-shard", sourceIds: ["resource-x"] });
    assert.ok(id);
    const boss = await getBoss();
    await registerSourceJobs(boss);
    await fixture.warm();
    await delay(2200);
    assert.equal(upstream.hits(), 1, "压力期间不能再向上游请求");
    const [pending] = await boss.findJobs(QUEUES.fetchXShard, { id });
    assert.equal(pending!.state, "created");
    assert.equal(pending!.retryCount, 0);
    const waiting = (await app.inject({ url: "/api/admin/sources/resource-x", headers })).json();
    assert.deepEqual(waiting.runs, before.runs);
    assert.equal(waiting.source.health, before.source.health);
    assert.equal(waiting.source.fail_count, before.source.fail_count);
    assert.equal(waiting.source.last_ok_at, before.source.last_ok_at);
    capacity.databaseBytes = 5.5 * 1024 ** 3; await database.sample();
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && (await boss.findJobs(QUEUES.fetchXShard, { id }))[0]!.state !== "completed") await delay(50);
    const [finished] = await boss.findJobs(QUEUES.fetchXShard, { id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    assert.equal(upstream.hits(), 2);
    const detail = (await app.inject({ url: "/api/admin/sources/resource-x", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    assert.ok(detail.items.some((item: { title: string }) => item.title === "新发布的镜头控制步骤"));
  } finally {
    await stopBoss(); await app.close(); await upstream.close();
    if (previousBase === undefined) delete process.env.SOCIALDATA_BASE_URL; else process.env.SOCIALDATA_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.SOCIALDATA_API_KEY; else process.env.SOCIALDATA_API_KEY = previousKey;
  }
});

