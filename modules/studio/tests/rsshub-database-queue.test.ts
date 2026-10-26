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
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createDatabaseResourceMonitor } from "../backend/database-resources.ts";
import { createBridgeQueue, enqueueNewsBridge } from "../backend/rsshub-jobs.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("RSSHub数据库达控制线不访问上游或记失败，恢复线前仍等待，恢复原任务后真实入库", async () => {
  let now = 0, databaseBytes = 6 * 1024 ** 3, requests = 0;
  const host = createHostResourceMonitor({ now: () => now,
    read: () => { now += 5000; return { availableMemoryBytes: 4 * 1024 ** 3,
      totalMemoryBytes: 8 * 1024 ** 3, cpus: [{ idle: now, total: now * 2 }] }; } });
  const disk = createDiskResourceMonitor({ availableBytes: async () => 20 * 1024 ** 3 });
  const database = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes, walBytes: 0, temporaryBytes: 0 }) });
  const queue = createBridgeQueue(host, disk, database);
  installModules(SERVER_MODULES.map(module => module.name === "studio" ? { ...module, queues: [queue] } : module));
  const app = await buildApp();
  const upstream = createServer((_req, res) => {
    requests++;
    res.end('<rss><channel><item><title>角色一致性更新</title><link>https://qwen.example/database-budget</link><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>');
  });
  const previous = process.env.STUDIO_RSSHUB_BASE_URL, collecting = process.env.COLLECT_ENABLED;
  process.env.STUDIO_RSSHUB_BASE_URL = await listenHttpForFetch(upstream);
  process.env.COLLECT_ENABLED = "true";
  let stop: (() => Promise<void>) | undefined;
  try {
    config.adminPassword = "database-queue-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=database-queue-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
    const headers = { cookie, "x-csrf-token": me.json().csrf as string };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "src-qwen-blog", name: "数据库恢复来源", kind: "external", config: {} } })).statusCode, 200);
    assert.equal((await enqueueNewsBridge({ id: "src-qwen-blog" })).queued, true);
    const boss = await getBoss();
    const [pending] = await boss.findJobs(queue.name, { queued: true });
    stop = await workModuleQueues(boss);
    for (let n = 0; n < 14; n++) host.sample();
    await disk.sample(); await database.sample();
    await delay(2200);
    assert.equal(requests, 0);
    assert.equal((await boss.findJobs(queue.name, { id: pending!.id }))[0]!.state, "created");
    assert.equal((await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json().runs.length, 0);
    databaseBytes = 5.75 * 1024 ** 3; await disk.sample(); await database.sample();
    await delay(2200);
    assert.equal(requests, 0, "容量小幅下降不能在恢复线之前反复启动");
    databaseBytes = 5.5 * 1024 ** 3; await disk.sample(); await database.sample();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await boss.findJobs(queue.name, { id: pending!.id }))[0]!.state !== "completed") await delay(50);
    assert.equal(requests, 1);
    const [finished] = await boss.findJobs(queue.name, { id: pending!.id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    const detail = (await app.inject({ url: "/api/admin/sources/src-qwen-blog", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    assert.equal(detail.items[0].title, "角色一致性更新");
  } finally {
    await stop?.(); await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env.STUDIO_RSSHUB_BASE_URL; else process.env.STUDIO_RSSHUB_BASE_URL = previous;
    if (collecting === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = collecting;
  }
});
