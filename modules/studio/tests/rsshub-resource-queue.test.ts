import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { createBridgeQueue, enqueueNewsBridge } from "../backend/rsshub-jobs.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("RSSHub真实队列在低内存时保留任务和来源健康，恢复后通过原采集流程收录", async () => {
  let now = 0, free = 1024 ** 3, requests = 0;
  const monitor = createHostResourceMonitor({ now: () => now,
    read: () => { now += 5000; return { availableMemoryBytes: free, totalMemoryBytes: 8 * 1024 ** 3, cpus: [{ idle: now, total: now * 2 }] }; } });
  const queue = createBridgeQueue(monitor);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const app = await buildApp();
  const upstream = createServer((_req, res) => {
    requests++;
    res.end('<rss><channel><item><title>视频创作者运镜更新</title><link>https://qwen.example/host-budget</link><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>');
  });
  const previous = process.env.STUDIO_RSSHUB_BASE_URL;
  const collecting = process.env.COLLECT_ENABLED;
  process.env.STUDIO_RSSHUB_BASE_URL = await listenHttpForFetch(upstream);
  process.env.COLLECT_ENABLED = "true";
  let stop: (() => Promise<void>) | undefined;
  try {
    config.adminPassword = "resource-queue-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=resource-queue-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
    const headers = { cookie, "x-csrf-token": me.json().csrf as string };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "src-qwen-blog", name: "压力恢复来源", kind: "external", config: {} } })).statusCode, 200);
    assert.equal((await enqueueNewsBridge({ id: "src-qwen-blog" })).queued, true);
    const boss = await getBoss();
    const [pending] = await boss.findJobs(queue.name, { queued: true });
    stop = await workModuleQueues(boss);
    await delay(650);
    assert.equal(requests, 0);
    assert.equal((await boss.findJobs(queue.name, { id: pending!.id }))[0]!.state, "created");
    const before = (await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json();
    assert.equal(before.runs.length, 0, "资源暂停不创建失败或空成功的采集记录");
    process.env.COLLECT_ENABLED = "false";
    free = 4 * 1024 ** 3;
    for (let n = 0; n < 13; n++) monitor.sample();
    await delay(2200);
    assert.equal(requests, 0, "采集开关关闭时不因资源恢复而领取或完成待执行任务");
    assert.equal((await boss.findJobs(queue.name, { id: pending!.id }))[0]!.state, "created");
    process.env.COLLECT_ENABLED = "true";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await boss.findJobs(queue.name, { id: pending!.id }))[0]!.state !== "completed") await delay(50);
    assert.equal(requests, 1);
    const [finished] = await boss.findJobs(queue.name, { id: pending!.id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    const detail = (await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    assert.equal(detail.items[0].title, "视频创作者运镜更新");
  } finally {
    await stop?.(); await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = previous;
    if (collecting === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = collecting;
  }
});
