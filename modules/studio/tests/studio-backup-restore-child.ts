import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
const { app, headers } = await sourceResourceFixture();
try {
  const restored = await app.inject({ url: "/api/admin/sources/studio-backup-restored", headers });
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().source.name, "备份中的私有来源");
  const imageId = process.env.BACKUP_RESTORE_IMAGE!;
  assert.match(imageId, /^[a-f0-9]{64}$/);
  const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const originalRoot = normalize(join(process.env.BACKUP_RESTORE_SOURCE_ROOT!, "studio", "image-assets"));
  const restoredRoot = normalize(await realpath(join(config.dataDir, "studio", "image-assets")));
  assert.notEqual(restoredRoot, originalRoot);
  const imageUrl = `/api/admin/studio/image-assets/${imageId}`;
  assert.equal((await app.inject({ url: imageUrl })).statusCode, 401);
  assert.equal((await app.inject({ url: imageUrl, headers })).statusCode, 500, "a restored database cannot silently read its old storage root");
  // Rehearse the documented offline relocation only on this newly restored *_restore_test database.
  // Production never automatically rebinds an arbitrary old storage path.
  const roots = await sql<{ storage_root: string }[]>`SELECT DISTINCT storage_root FROM studio_image_assets`;
  assert.deepEqual(roots.map(row => row.storage_root), [originalRoot]);
  await sql`UPDATE studio_image_assets SET storage_root = ${restoredRoot} WHERE storage_root = ${originalRoot}`;
  const image = await app.inject({ url: imageUrl, headers });
  assert.equal(image.statusCode, 200); assert.equal(image.headers["content-type"], "image/png");
  assert.equal(createHash("sha256").update(image.rawPayload).digest("hex"), imageId);
  const budget = await app.inject({ url: "/api/admin/studio/model-budget", headers });
  assert.equal(budget.statusCode, 200); assert.equal(budget.json().perDay, 7); assert.equal(budget.json().perMonth, 90);
  const collection = await app.inject({ url: "/api/admin/studio/collection-operations", headers });
  assert.equal(collection.statusCode, 200); assert.equal(collection.json().enabled, false);
  console.log("STUDIO_BACKUP_RESTORE_RESULT=" + JSON.stringify({ restoredSource: true, restoredImage: true, restoredSettings: true, originalRootRejected: true }));
} finally { await app.close(); await closeDb(); }
