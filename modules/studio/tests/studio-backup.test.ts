import { inSettingsSection } from "./settings-navigation.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { createImageAssets } from "../backend/image-assets.ts";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { startWebServer } from "../../../apps/web/tests/web-server.ts";

const { app, headers } = await sourceResourceFixture();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
test("完整备份保存数据库与图片设置，异路径恢复后私有读取且原数据不变，未配置不假称保护", async t => {
  const url = "/api/admin/studio/backup", previous = process.env.STUDIO_BACKUP_DIRECTORY;
  delete process.env.STUDIO_BACKUP_DIRECTORY;
  t.after(() => { if (previous === undefined) delete process.env.STUDIO_BACKUP_DIRECTORY; else process.env.STUDIO_BACKUP_DIRECTORY = previous; });
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url, headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ url, headers })).json().configured, false);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 409);
  await mkdir(".local/backup-tests", { recursive: true }); const target = await mkdtemp(join(process.cwd(), ".local/backup-tests/capture-"));
  t.after(() => rm(target, { recursive: true, force: true })); process.env.STUDIO_BACKUP_DIRECTORY = target;
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#226655" } }).png().toBuffer();
  const saved = await createImageAssets().put({ body: image, type: "image/png" });
  await createImageAssets().setReferences("backup-fixture:retained", [saved.id]);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "studio-backup-restored", name: "备份中的私有来源", kind: "rss", config: { feedUrl: "https://backup.example/rss" } } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-budget", headers, payload: { version: 0, perDay: 7, perMonth: 90 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/collection-operations", headers, payload: { version: 0, enabled: false } })).statusCode, 200);
  const sent = await app.inject({ method: "POST", url, headers, payload: {} }); assert.equal(sent.statusCode, 200, sent.body);
  const repeated = await app.inject({ method: "POST", url, headers, payload: {} }); assert.equal(repeated.json().queued, false); assert.equal(repeated.json().jobId, sent.json().jobId);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.backup.capture")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
  const result = (await app.inject({ url, headers })).json(); assert.equal(result.state, "completed"); assert.equal(result.protected, false);
  assert.ok(!JSON.stringify(result).includes(target));
  const directory = join(target, result.last.id), manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.format, 1); assert.equal(manifest.requiresOriginalSessionSecret, true);
  for (const name of ["database.dump", `data/studio/image-assets/${saved.id}.image`, "data/llm-budget/limits.json", "data/collection-control/state.json"]) {
    const entry = manifest.files.find((file: {name: string}) => file.name === name); assert.ok(entry, name);
    const bytes = await readFile(join(directory, name)); assert.equal(bytes.length, entry.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
  assert.deepEqual(await readFile(join(directory, `data/studio/image-assets/${saved.id}.image`)), image);
  assert.equal(JSON.parse(await readFile(join(directory, "data/llm-budget/limits.json"), "utf8")).perDay, 7);
  const listed = await promisify(execFile)("pg_restore", ["--list", join(directory, "database.dump")], { windowsHide: true });
  assert.ok(listed.stdout.includes("studio_creator_accounts")); assert.ok(listed.stdout.includes("studio_writing_projects"));
  const databaseName = "studio_backup_" + randomUUID().replaceAll("-", "") + "_restore_test";
  assert.match(databaseName, /^[a-z0-9_]+_restore_test$/);
  await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
  t.after(() => sql.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`));
  const address = new URL(config.databaseUrl); address.pathname = "/" + databaseName; const restoredUrl = address.toString(), password = decodeURIComponent(address.password); address.password = "";
  await promisify(execFile)("pg_restore", ["--no-owner", "--dbname", address.toString(), join(directory, "database.dump")], { windowsHide: true, env: { ...process.env, PGPASSWORD: password }, timeout: 60000 });
  const restoredWorkspace = await mkdtemp(join(process.cwd(), ".local/backup-tests/restored-data-"));
  const restoredData = join(restoredWorkspace, "data");
  t.after(async () => {
    const within = relative(await realpath(resolve(".local/backup-tests")), await realpath(restoredWorkspace));
    assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
    await rm(restoredWorkspace, { recursive: true, force: true });
  });
  await cp(join(directory, "data"), restoredData, { recursive: true, errorOnExist: true, force: false });
  for (const entry of manifest.files as Array<{ name: string; bytes: number; sha256: string }>) {
    if (!entry.name.startsWith("data/")) continue;
    const body = await readFile(join(restoredData, ...entry.name.slice(5).split("/")));
    assert.equal(body.length, entry.bytes);
    assert.equal(createHash("sha256").update(body).digest("hex"), entry.sha256);
  }
  const child = await promisify(execFile)(process.execPath, ["modules/studio/tests/studio-backup-restore-child.ts"], {
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: restoredUrl, AIHOT_DATA_DIR: restoredData,
      BACKUP_RESTORE_SOURCE_ROOT: manifest.sourceDataRoot, BACKUP_RESTORE_IMAGE: saved.id },
    timeout: 20000,
  });
  const results = child.stdout.split(/\r?\n/).filter(line => line.startsWith("STUDIO_BACKUP_RESTORE_RESULT="));
  assert.equal(results.length, 1);
  assert.deepEqual(JSON.parse(results[0]!.slice("STUDIO_BACKUP_RESTORE_RESULT=".length)), { restoredSource: true, restoredImage: true, restoredSettings: true, originalRootRejected: true });
  const original = await app.inject({ url: `/api/admin/studio/image-assets/${saved.id}`, headers });
  assert.equal(original.statusCode, 200); assert.deepEqual(original.rawPayload, image);
});

test("数据库声明已保存的素材实际缺失时备份失败，保留上一份完整记录", async t => {
  const before = (await app.inject({ url: "/api/admin/studio/backup", headers })).json();
  const target = await mkdtemp(join(process.cwd(), ".local/backup-tests/missing-"));
  const previous = process.env.STUDIO_BACKUP_DIRECTORY; process.env.STUDIO_BACKUP_DIRECTORY = target;
  t.after(async () => { if (previous === undefined) delete process.env.STUDIO_BACKUP_DIRECTORY; else process.env.STUDIO_BACKUP_DIRECTORY = previous; await rm(target, { recursive: true, force: true }); });
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#112255" } }).png().toBuffer();
  const saved = await createImageAssets().put({ body: image, type: "image/png" });
  await createImageAssets().setReferences("backup-fixture:missing", [saved.id]);
  const file = join(config.dataDir, "studio/image-assets", saved.id + ".image"); await unlink(file);
  t.after(() => writeFile(file, image));
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/backup", headers, payload: {} })).statusCode, 200);
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.backup.capture")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  t.after(() => boss.fail(queue.name, job.id));
  await assert.rejects(queue.run([job.data] as never[]), /完整备份未完成/);
  const failed = (await app.inject({ url: "/api/admin/studio/backup", headers })).json();
  assert.equal(failed.state, "failed"); assert.equal(failed.last.id, before.last.id); assert.equal(failed.protected, false);
});

test("设置显示未保护并可显式提交真实备份，独立刷新不丢Key，桌面窄屏可操作", async t => {
  const previous = process.env.STUDIO_BACKUP_DIRECTORY; delete process.env.STUDIO_BACKUP_DIRECTORY;
  const target = await mkdtemp(join(process.cwd(), ".local/backup-tests/browser-"));
  t.after(async () => { if (previous === undefined) delete process.env.STUDIO_BACKUP_DIRECTORY; else process.env.STUDIO_BACKUP_DIRECTORY = previous; await rm(target, { recursive: true, force: true }); });
  const web = await startWebServer(app.server), browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(web.origin + "/admin/studio/settings/backup"); await page.locator('input[name="password"]').fill("source-resource-password"); await page.locator('button[type="submit"]').click();
    await inSettingsSection(page, "models", () => page.getByLabel("API Key", { exact: true }).fill("backup-unsaved-key"));
    const section = page.getByRole("region", { name: "数据备份", exact: true }); await expect(section.getByRole("heading", { name: "备份状态与操作", exact: true })).toBeVisible();
    await expect(section.getByRole("status")).toContainText("未保护 · 尚未配置备份位置");
    await expect(section.getByRole("button", { name: "开始完整备份", exact: true })).toBeDisabled();
    process.env.STUDIO_BACKUP_DIRECTORY = target;
    await section.getByRole("button", { name: "刷新备份状态", exact: true }).click();
    await expect(section.getByRole("button", { name: "开始完整备份", exact: true })).toBeEnabled();
    page.once("dialog", dialog => dialog.accept()); await section.getByRole("button", { name: "开始完整备份", exact: true }).click();
    await expect(section.getByRole("status")).toContainText("等待后台处理");
    const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.backup.capture")!;
    const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
    await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    await expect(section.getByRole("status")).toContainText("上次任务已完成", { timeout: 10000 });
    await expect(section.getByRole("status")).toContainText("尚无近期完整机外备份");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("backup-unsaved-key");
    await mkdir(".impeccable/review", { recursive: true });
    for (const [width, suffix] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), false);
      await section.screenshot({ path: `.impeccable/review/studio-backup-${suffix}.png` });
    }
  } finally { await browser.close(); await web.stop(); }
});

test("排队后更换备份位置拒绝旧任务，不向两个目录写入或覆盖上次完整记录", async t => {
  const previous = process.env.STUDIO_BACKUP_DIRECTORY, targets: string[] = [];
  for (const name of ["old-", "new-"]) targets.push(await mkdtemp(join(process.cwd(), ".local/backup-tests/" + name)));
  t.after(async () => { if (previous === undefined) delete process.env.STUDIO_BACKUP_DIRECTORY; else process.env.STUDIO_BACKUP_DIRECTORY = previous; for (const target of targets) await rm(target, { recursive: true, force: true }); });
  process.env.STUDIO_BACKUP_DIRECTORY = targets[0];
  const before = (await app.inject({ url: "/api/admin/studio/backup", headers })).json();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/backup", headers, payload: {} })).statusCode, 200);
  process.env.STUDIO_BACKUP_DIRECTORY = targets[1];
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.backup.capture")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job); t.after(() => boss.fail(queue.name, job.id));
  await assert.rejects(queue.run([job.data] as never[]), /完整备份未完成/);
  const after = (await app.inject({ url: "/api/admin/studio/backup", headers })).json();
  assert.equal(after.state, "failed"); assert.equal(after.last.id, before.last.id);
  const { readdir } = await import("node:fs/promises"); for (const target of targets) assert.deepEqual(await readdir(target), []);
});
