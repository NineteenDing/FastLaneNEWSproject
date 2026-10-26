import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

test("本机导入命令拒绝原业务或远程目标，不回显连接凭据", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "studio-import-"));
  try {
    for (const url of ["postgres://secret:password@remote.example/studio_local", "postgres://secret:password@127.0.0.1/business"]) {
      const file = path.join(folder, "config.env");
      await writeFile(file, `DATABASE_URL=${url}\n`);
      let output = "";
      try { await promisify(execFile)(process.execPath, ["modules/studio/scripts/import-news.ts"], { env: { ...process.env, STUDIO_LOCAL_ENV: file } }); }
      catch (error) { output = (error as { stdout: string }).stdout; }
      assert.ok(output.includes("LOCAL_DATABASE_REFUSED"));
      assert.ok(!output.includes("password"));
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
