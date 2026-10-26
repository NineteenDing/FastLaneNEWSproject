import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { createHostResourceMonitor } from "../backend/host-resources.ts";
import { createDiskResourceMonitor } from "../backend/disk-resources.ts";
import { createDatabaseResourceMonitor } from "../backend/database-resources.ts";
import { createCollectionAdmission } from "../backend/collection-admission.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("实际手动force新闻任务在容量保护时保持待领取和来源健康，恢复后沿用原ID完成RSS入库", async () => {
  let now = 0, usage = 6 * 1024 ** 3, otherUsage = 6 * 1024 ** 3, requests = 0;
  const makeHost = () => createHostResourceMonitor({ now: () => now, read: () => {
    now += 5000; return { availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3,
      cpus: [{ idle: now, total: now * 2 }] };
  } });
  const host = makeHost(), otherHost = makeHost();
  const disk = createDiskResourceMonitor({ availableBytes: async () => 20 * 1024 ** 3 });
  const database = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes: usage, walBytes: 0, temporaryBytes: 0 }) });
  const admission = createCollectionAdmission({ host, disk, database });
  const otherDatabase = createDatabaseResourceMonitor({ read: async () => ({ databaseBytes: otherUsage, walBytes: 0, temporaryBytes: 0 }) });
  const otherAdmission = createCollectionAdmission({ host: otherHost, database: otherDatabase,
    disk: createDiskResourceMonitor({ availableBytes: async () => 20 * 1024 ** 3 }) });
  installModules([...SERVER_MODULES.map(module => module.name === "studio" ? { ...module, sourceCollectionAdmission: admission } : module),
    { name: "second-resource-owner", sourceCollectionAdmission: otherAdmission }]);
  const app = await buildApp();
  const upstream = createServer((_req, res) => {
    requests++;
    res.end('<rss><channel><item><title>镜头衔接实操更新</title><link>https://news.example/resource-queue</link><description>明确的创作步骤</description><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>');
  });
  const url = await listenHttpForFetch(upstream);
  const enabled = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "true";
  config.allowPrivateNetworkFetch = true;
  try {
    config.adminPassword = "news-resource-queue-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=news-resource-queue-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
    const headers = { cookie, "x-csrf-token": me.json().csrf as string };
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers,
      payload: { id: "resource-rss", name: "受控普通新闻", kind: "rss", participation_mode: "hot_signal", config: { feedUrl: url } } })).statusCode, 200);
    const submitted = await app.inject({ method: "POST", url: "/api/admin/sources/resource-rss/fetch", headers });
    assert.equal(submitted.statusCode, 200);
    const id = submitted.json().jobId as string;
    const boss = await getBoss();
    await registerSourceJobs(boss);
    for (let n = 0; n < 14; n++) { host.sample(); otherHost.sample(); }
    await disk.sample(); await database.sample();
    await delay(2200);
    assert.equal(requests, 0);
    const [pending] = await boss.findJobs<{ sourceId: string; force?: boolean }>(QUEUES.fetchSource, { id });
    assert.equal(pending!.state, "created");
    assert.equal(pending!.data.force, true);
    assert.equal(pending!.retryCount, 0);
    const before = (await app.inject({ url: "/api/admin/sources/resource-rss", headers })).json();
    assert.equal(before.runs.length, 0);
    assert.equal(before.source.health, "unknown");
    assert.equal(before.source.fail_count, 0);
    assert.equal(before.source.last_ok_at, null);
    usage = 5.75 * 1024 ** 3; await database.sample();
    await delay(2200);
    assert.equal(requests, 0);
    usage = 5.5 * 1024 ** 3; await database.sample();
    await delay(2200);
    assert.equal(requests, 0, "其他已安装的资源准入未恢复时仍需等待");
    otherUsage = 1024 ** 3; await otherDatabase.sample();
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && (await boss.findJobs(QUEUES.fetchSource, { id }))[0]!.state !== "completed") await delay(50);
    const [finished] = await boss.findJobs(QUEUES.fetchSource, { id });
    assert.equal(finished!.state, "completed");
    assert.equal(finished!.retryCount, 0);
    assert.equal(requests, 1);
    const detail = (await app.inject({ url: "/api/admin/sources/resource-rss", headers })).json();
    assert.equal(detail.runs[0].status, "ok");
    assert.equal(detail.items[0].title, "镜头衔接实操更新");
  } finally {
    await stopBoss(); await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (enabled === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = enabled;
  }
});
