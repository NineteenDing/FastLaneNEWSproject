import { gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { collectSource } from "@aihot/backend/sources/collect";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("新闻正文在磁盘保护时保留原任务和材料，恢复后同ID保存正文并继续处理", async () => {
  const fixture = await sourceResourceFixture();
  const { app, headers, capacity, disk, host, admission } = fixture;
  capacity.diskBytes = 4_000_000_000;
  let requests = 0, base = "";
  const entered = gate(), release = gate();
  let stopping: Promise<void> | undefined;
  const body = "人物一致性首先取决于固定参考图。先整理角色正面、侧面和不同表情，再保持同一组镜头参数。".repeat(10);
  const upstream = createServer(async (req, res) => {
    if (req.url === "/feed") {
      res.setHeader("content-type", "application/rss+xml");
      res.end(`<rss><channel><item><title>角色一致性操作说明</title><link>${base}/article</link><description>本次新增可演示的镜头步骤</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
    } else {
      requests++;
      entered.open(); await release.promise;
      res.setHeader("content-type", "text/html");
      res.end(`<html><head><title>角色一致性操作说明</title></head><body><article><h1>角色一致性操作说明</h1><p>${body}</p></article></body></html>`);
    }
  });
  base = await listenHttpForFetch(upstream);
  config.allowPrivateNetworkFetch = true;
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "resource-body-rss", name: "正文采集来源", kind: "rss", config: { feedUrl: `${base}/feed`, fetchPublicContent: true } } })).statusCode, 200);
    assert.equal((await collectSource("resource-body-rss", { force: true })).status, "ok");
    const source = (await app.inject({ url: "/api/admin/sources/resource-body-rss", headers })).json();
    const articleId = source.items[0].id as string;
    const boss = await getBoss();
    const [queued] = (await boss.findJobs<{ articleId: string }>(QUEUES.extractBody, {})).filter(job => job.data.articleId === articleId);
    assert.ok(queued);
    assert.equal(queued.state, "created");
    // Explicit re-extraction reuses the durable task; it must not bypass pressure protection.
    const manual = await app.inject({ method: "POST", url: `/api/admin/content/${articleId}/rerun`,
      headers: { ...headers, "idempotency-key": "resource-body-manual" }, payload: { step: "extract" } });
    assert.equal(manual.statusCode, 200);
    const before = (await app.inject({ url: `/api/admin/content/${articleId}`, headers })).json();
    assert.equal(before.article.body_status, "pending");
    assert.equal(before.article.revision, 1);
    await registerSourceJobs(boss);
    await fixture.warm();
    await delay(2200);
    assert.equal(requests, 0, "磁盘保护时不能读取正文");
    const [pending] = await boss.findJobs(QUEUES.extractBody, { id: queued.id });
    assert.equal(pending!.state, "created");
    assert.equal(pending!.retryCount, 0);
    const waiting = (await app.inject({ url: `/api/admin/content/${articleId}`, headers })).json();
    assert.deepEqual(waiting.article, before.article);
    assert.deepEqual(waiting.revisions, before.revisions);
    assert.deepEqual(waiting.analyses, []);
    capacity.diskBytes = 5_900_000_000; await disk.sample();
    await delay(2200);
    assert.equal(requests, 0, "保护后的恢复仍需要达到6GB");
    capacity.diskBytes = 6_000_000_000; await disk.sample();
    await Promise.race([entered.promise, delay(4500).then(() => { throw new Error("恢复后未开始读取正文"); })]);
    stopping = stopBoss({ timeoutMs: 8000 });
    await delay(100);
    assert.equal(host.status().state, "ready", "空闲新闻队列退出不能释放仍在提取正文的监测");
    assert.throws(() => admission(), /活动消费者/);
    release.open(); await stopping;
    assert.equal(host.status().state, "unavailable");
    const nextOwner = admission();
    try { assert.equal(nextOwner.canStart(), false); }
    finally { nextOwner.stop(); }
    const observer = await getBoss();
    const [finished] = await observer.findJobs(QUEUES.extractBody, { id: queued.id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    assert.equal(requests, 1);
    const detail = (await app.inject({ url: `/api/admin/content/${articleId}`, headers })).json();
    assert.equal(detail.article.body_status, "ok");
    assert.equal(detail.article.revision, 2);
    assert.ok(detail.article.body_chars >= 200);
    assert.equal(detail.article.processing_error, null);
    assert.equal(detail.analyses.length, 0);
    const next = await observer.getQueue(QUEUES.analyze)
      ? (await observer.findJobs<{ articleId: string }>(QUEUES.analyze, {})).filter(job => job.data.articleId === articleId) : [];
    assert.equal(next.length, 0, "工作台正文保存后不能再登记旧新闻站分析任务");
    const analysis = await app.inject({ url: `/api/admin/studio/intelligence/news:${articleId}/analysis`, headers });
    assert.equal(analysis.statusCode, 200);
    assert.equal(analysis.json().state, "pending", "可靠正文进入Studio待分析流程，保留暂停与恢复能力");
  } finally {
    release.open(); await stopping;
    await stopBoss(); await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
