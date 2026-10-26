import { spawn } from "node:child_process";
import path from "node:path";
import { localProcessEnvironment } from "./local-environment.ts";

/** The config was already validated as a local project database by the operator entry point. */
export async function runLocalTests(database: URL, files: string[]) {
  const name = process.env.STUDIO_TEST_DATABASE || "studio_test";
  if (!/^[a-z][a-z0-9_]*_(test|ci)$/.test(name) || name.length > 63) throw new Error("LOCAL_TEST_DATABASE_INVALID");
  const selected = files.map(file => file.replaceAll("\\", "/"));
  if (selected.some(file => file.split("/").includes("..") || !/^(tests\/|modules\/[^/]+\/tests\/).*\.ts$/.test(file))) throw new Error("LOCAL_TEST_FILES_INVALID");
  const url = new URL(database); url.pathname = `/${name}`;
  const child = spawn(process.execPath, ["--test-global-setup=tests/databases.ts", "--import", "./tests/databases.ts",
    "--test", "--test-concurrency=2", "--test-timeout=120000", ...(selected.length ? selected : ["tests/*.test.ts", "modules/*/tests/*.test.ts"])], {
    cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, stdio: "inherit",
    env: { ...localProcessEnvironment(), DATABASE_URL: url.toString() },
  });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
}
