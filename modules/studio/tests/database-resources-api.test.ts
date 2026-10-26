import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../../../apps/api/src/app.ts";
import type { DatabaseResourceStatus } from "../contracts.ts";

after(closeDb);

test("数据库容量状态只向登录用户返回不缓存分项和控制线，不暴露数据库名称、路径或秘密", async () => {
  installModules(SERVER_MODULES);
  const app = await buildApp();
  try {
    assert.equal((await app.inject({ url: "/api/admin/studio/database-resources" })).statusCode, 401);
    config.adminPassword = "database-resource-test-password";
    const login = await app.inject({ method: "POST", url: "/api/auth/password", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "username=admin&password=database-resource-test-password" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    let response = await app.inject({ url: "/api/admin/studio/database-resources", headers: { cookie } });
    const deadline = Date.now() + 2000;
    while (response.json<DatabaseResourceStatus>().state === "warming" && Date.now() < deadline) {
      await delay(10);
      response = await app.inject({ url: "/api/admin/studio/database-resources", headers: { cookie } });
    }
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /no-store/);
    const status = response.json<DatabaseResourceStatus>();
    assert.deepEqual(Object.keys(status).sort(), ["databaseBytes", "estimatedRemainingSeconds", "ingestionAllowed", "limitBytes", "sampleAgeMs", "scope", "state", "temporaryBytes", "usedBytes", "walBytes"]);
    assert.equal(status.scope, "database_with_shared_wal_temp");
    assert.equal(status.limitBytes, 6442450944);
    assert.ok(status.databaseBytes! > 0);
    assert.ok(status.walBytes! >= 16 * 1024 ** 2);
    assert.equal(status.ingestionAllowed, true);
    assert.ok(status.sampleAgeMs !== null && status.sampleAgeMs < 90_000);
  } finally { await app.close(); await stopBoss(); }
});
