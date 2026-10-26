// Exercise the operator CLI, not its configuration helpers. No original env or database is used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listenHttpForFetch } from "./http-listener.ts";

const exec = promisify(execFile);
async function check(file: string) {
  try {
    return { ...(await exec(process.execPath, ["scripts/studio-local.ts", "check"], {
      env: { ...process.env, STUDIO_LOCAL_ENV: file }, timeout: 15_000,
    })), code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number };
    return failure;
  }
}

test("local check explains missing setup without loading the original project's environment", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "studio-cli-"));
  try {
    const result = await check(path.join(folder, "missing.env"));
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "LOCAL_ENV_MISSING", message: "缺少本项目的本机配置文件。请按本机运行说明准备配置。" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("local check refuses a business or remote database and never prints its credentials", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "studio-cli-"));
  try {
    const file = path.join(folder, "config.env");
    for (const url of ["postgres://owner:private-secret@127.0.0.1:55432/aihot", "postgres://owner:private-secret@203.0.113.1/studio_local", "postgres://owner:private-secret@127.0.0.1/studio_test?host=203.0.113.1"]) {
      await writeFile(file, `DATABASE_URL=${url}\n`);
      const result = await check(file);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).code, "LOCAL_DATABASE_REFUSED");
      assert.ok(!`${result.stdout}${result.stderr}`.includes("private-secret"));
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("local check reports an unavailable database instead of claiming the app is ready", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "studio-cli-"));
  try {
    const file = path.join(folder, "config.env");
    await writeFile(file, "DATABASE_URL=postgres://owner:private-secret@127.0.0.1:1/studio_test\n");
    const result = await check(file);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).code, "LOCAL_DATABASE_UNAVAILABLE");
    assert.ok(!`${result.stdout}${result.stderr}`.includes("private-secret"));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("local stop reaches its authenticated control even on a Fetch-blocked port", async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/control-test-"));
  const token = "a".repeat(64);
  const server = createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/stop");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.end(JSON.stringify({ ok: true, state: "stopped" }));
  });
  try {
    server.listen(6000, "127.0.0.1");
    await once(server, "listening");
    await writeFile(path.join(folder, "studio.json"), JSON.stringify({ root: path.resolve("."), port: 6000, token }));
    const result = await exec(process.execPath, ["scripts/studio-local.ts", "stop"], {
      env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, state: "stopped" });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

test("local status and stop never claim stopped while a resource group has no verified control", async () => {
  const folder = await mkdtemp(path.resolve(".local/control-pending-"));
  try {
    await writeFile(path.join(folder, "windows-group.json"), "unconfirmed owner");
    for (const command of ["status", "stop"]) {
      await assert.rejects(exec(process.execPath, ["scripts/studio-local.ts", command], {
        env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 15_000,
      }), error => JSON.parse((error as { stdout: string }).stdout).code === "LOCAL_RESOURCE_STATE_UNCONFIRMED");
    }
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("local stop waits for the owned resource group confirmation before reporting stopped", async () => {
  const folder = await mkdtemp(path.resolve(".local/control-stop-confirm-")), token = "b".repeat(64);
  let confirmed = false;
  let cleanup: Promise<void> | undefined;
  const group = path.join(folder, "windows-group.json");
  const server = createServer((_req, res) => {
    res.end(JSON.stringify({ ok: true, state: "stopped" }));
    cleanup = new Promise(resolve => setTimeout(() => {
      void unlink(group).then(() => { confirmed = true; resolve(); });
    }, 700));
  });
  try {
    const origin = await listenHttpForFetch(server);
    await writeFile(group, "owned group awaiting exit confirmation");
    await writeFile(path.join(folder, "studio.json"), JSON.stringify({ root: path.resolve("."), port: Number(new URL(origin).port), token }));
    const result = await exec(process.execPath, ["scripts/studio-local.ts", "stop"], {
      env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, state: "stopped" });
    assert.equal(confirmed, true, "HTTP response alone must not bypass remaining group exit confirmation");
  } finally {
    await cleanup;
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("local control rejects incomplete protected status instead of trusting unchecked JSON", async () => {
  const folder = await mkdtemp(path.resolve(".local/control-protocol-")), token = "c".repeat(64);
  const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, state: "running", web: "http://127.0.0.1:4310",
    api: "http://127.0.0.1:4311", worker: "disabled", externalActions: "disabled", resources: { state: "protected" } })));
  try {
    const origin = await listenHttpForFetch(server);
    await writeFile(path.join(folder, "studio.json"), JSON.stringify({ root: path.resolve("."), port: Number(new URL(origin).port), token }));
    await assert.rejects(exec(process.execPath, ["scripts/studio-local.ts", "status"], {
      env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 15_000,
    }), error => JSON.parse((error as { stdout: string }).stdout).code === "LOCAL_STATE_INVALID");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test("local status accepts explicit collection permissions but rejects contradictory or untyped media permission", async () => {
  const folder = await mkdtemp(path.resolve(".local/control-permissions-")), token = "d".repeat(64);
  let permission: Record<string, unknown> = {};
  const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, state: "running", web: "http://127.0.0.1:4310",
    api: "http://127.0.0.1:4311", worker: "disabled", ...permission, privatePath: "not-for-control-output" })));
  try {
    const origin = await listenHttpForFetch(server);
    await writeFile(path.join(folder, "studio.json"), JSON.stringify({ root: path.resolve("."), port: Number(new URL(origin).port), token }));
    for (const externalActions of ["collection_allowed", "models_and_collection_allowed"]) {
      permission = { externalActions, mediaProcessingAllowed: true };
      const result = JSON.parse((await exec(process.execPath, ["scripts/studio-local.ts", "status"], {
        env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 15_000,
      })).stdout);
      assert.equal(result.externalActions, externalActions); assert.equal(result.mediaProcessingAllowed, true);
      assert.equal(result.privatePath, undefined, "许可字段扩充不放宽原白名单投影");
    }
    for (const invalid of [
      { externalActions: "disabled", mediaProcessingAllowed: true }, { externalActions: "models_allowed", mediaProcessingAllowed: true },
      { externalActions: "collection_allowed", mediaProcessingAllowed: "true" }, { externalActions: "all_allowed", mediaProcessingAllowed: false },
    ]) {
      permission = invalid;
      await assert.rejects(exec(process.execPath, ["scripts/studio-local.ts", "status"], {
        env: { ...process.env, STUDIO_LOCAL_RUN_DIR: folder }, timeout: 15_000,
      }), error => JSON.parse((error as { stdout: string }).stdout).code === "LOCAL_STATE_INVALID");
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    await rm(folder, { recursive: true, force: true });
  }
});
