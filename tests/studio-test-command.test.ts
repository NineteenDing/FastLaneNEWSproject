import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import postgres from "postgres";

test("local test command handles long template names, cleans copies and excludes real secrets", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "studio-test-command-"));
  const file = path.join(folder, "config.env");
  const template = "a".repeat(40) + randomBytes(4).toString("hex") + "_test";
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  const server = postgres(url.toString(), { max: 1, onnotice: () => {} });
  let copy: string | undefined;
  try {
    await writeFile(file, `DATABASE_URL=${process.env.DATABASE_URL}\nDEEPSEEK_API_KEY=never-pass-this-real-key\n`);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/studio-local.ts", "test", "tests/fixtures/studio-test-probe.ts"], {
      env: { ...process.env, STUDIO_LOCAL_ENV: file, STUDIO_TEST_DATABASE: template,
        DEEPSEEK_API_KEY: "never-pass-this-real-key", DEV_AUTH_ROLE: "admin" }, timeout: 25_000,
    });
    assert.ok(!`${stdout}${stderr}`.includes("never-pass-this-real-key"));
    copy = stdout.match(/isolated-database:([a-z0-9_]+)/)?.[1];
    assert.ok(copy, "the actual isolated database must have been reached");
    assert.notEqual(copy, template);
    assert.equal((await server`SELECT datname FROM pg_database WHERE datname = ${copy}`).length, 0, "test copy must be removed after the run");
  } finally {
    if (copy) await server`DROP DATABASE IF EXISTS ${server(copy)} WITH (FORCE)`;
    await server`DROP DATABASE IF EXISTS ${server(template)} WITH (FORCE)`;
    await server.end();
    await rm(folder, { recursive: true, force: true });
  }
});
