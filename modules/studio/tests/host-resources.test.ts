import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import type { DiskResourceStatus, HostResourceStatus } from "../contracts.ts";

after(closeDb);

test("主机压力状态仅登录可见且不缓存，不泄露主机名、路径、PID或其他进程资料", async () => {
  installModules(SERVER_MODULES);
  const app = await buildApp();
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/host-resources" })).statusCode, 401);
    config.adminPassword = "host-resource-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=host-resource-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const response = await app.inject({ url: "/api/admin/studio/host-resources", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /no-store/);
    const status = response.json<HostResourceStatus>();
    assert.equal(status.scope, "host");
    assert.deepEqual(Object.keys(status).sort(), ["availableMemoryBytes", "cpuPercent", "reasons", "releaseIdleResources", "sampleAgeMs", "scope", "state", "totalMemoryBytes"]);
    assert.ok(Number.isSafeInteger(status.availableMemoryBytes) && status.availableMemoryBytes! >= 0);
    assert.ok(Number.isSafeInteger(status.totalMemoryBytes) && status.totalMemoryBytes! > 0);
    assert.ok(status.sampleAgeMs !== null && status.sampleAgeMs >= 0);
    assert.equal(status.cpuPercent, null, "刚启动尚无两个后台样本");
    assert.notEqual(status.state, "ready");
  } finally { await app.close(); await stopBoss(); }
});

test("磁盘预留查询被真实PG锁阻塞时API仍能就绪和登录，采集状态保持禁止", async () => {
  installModules(SERVER_MODULES);
  let unlock!: () => void, locked!: () => void;
  const held = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const locking = sql.begin(async tx => {
    await tx`LOCK TABLE studio_storage_workspaces IN ACCESS EXCLUSIVE MODE`;
    locked(); await release;
  });
  await held;
  const app = await buildApp(), ready = app.ready();
  try {
    assert.equal(await Promise.race([ready.then(() => true), delay(1000).then(() => false)]), true,
      "磁盘状态暂不可用不能阻止网页和登录启动");
    config.adminPassword = "blocked-disk-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=blocked-disk-test-password" });
    assert.equal(login.statusCode, 303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const response = await app.inject({ url: "/api/admin/studio/disk-resources", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<DiskResourceStatus>().ingestionAllowed, false);
  } finally {
    unlock(); await locking; await ready; await app.close(); await stopBoss();
  }
});

test("磁盘压力API只向登录用户提供不缓存的空间与准入状态，不泄露目录或预留任务", async () => {
  installModules(SERVER_MODULES);
  const app = await buildApp();
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/disk-resources" })).statusCode, 401);
    config.adminPassword = "disk-resource-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=disk-resource-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    let response = await app.inject({ url: "/api/admin/studio/disk-resources", headers: { cookie } });
    const deadline = Date.now() + 1000;
    while (response.json<DiskResourceStatus>().state === "warming" && Date.now() < deadline) {
      await delay(10);
      response = await app.inject({ url: "/api/admin/studio/disk-resources", headers: { cookie } });
    }
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /no-store/);
    const status = response.json<DiskResourceStatus>();
    assert.equal(status.scope, "data_volume");
    assert.deepEqual(Object.keys(status).sort(), ["availableBytes", "heavyTaskAllowed", "ingestionAllowed", "reservedBytes", "sampleAgeMs", "scope", "state", "unreservedBytes"]);
    assert.ok(Number.isSafeInteger(status.availableBytes) && status.availableBytes! >= 0);
    assert.equal(status.reservedBytes, 0);
    assert.ok(status.sampleAgeMs !== null && status.sampleAgeMs >= 0);
  } finally { await app.close(); await stopBoss(); }
});
