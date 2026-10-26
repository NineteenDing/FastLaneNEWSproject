import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "../backend/collection-admission.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("媒体重任务在5GB时等待而普通入库仍可用，5.9GB不恢复，6GB再放行", async () => {
  const fixture = await sourceResourceFixture();
  const { host, disk, database, capacity, app } = fixture;
  const media = createCollectionAdmission({ host, disk, database, heavy: true, enabled: () => true });
  const owned = media();
  try {
    await fixture.warm();
    assert.equal(owned.canStart(), true);
    capacity.diskBytes = 5_000_000_000; await disk.sample();
    assert.equal(disk.status().ingestionAllowed, true);
    assert.equal(owned.canStart(), false);
    capacity.diskBytes = 5_900_000_000; await disk.sample();
    assert.equal(owned.canStart(), false);
    capacity.diskBytes = 6_000_000_000; await disk.sample();
    assert.equal(owned.canStart(), true);
    capacity.memoryBytes = 1024 ** 3; host.sample();
    assert.equal(owned.canStart(), false);
  } finally { owned.stop(); await app.close(); }
});
