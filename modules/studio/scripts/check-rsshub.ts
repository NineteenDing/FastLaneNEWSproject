// Read-only operator check: no application import, database, network or installation.
import path from "node:path";
import { loadRsshubBuildManifest, verifyRsshubBuild } from "../backend/rsshub-build.ts";

const root = path.resolve(import.meta.dirname, "../../..");
try {
  const directory = path.resolve(root, process.argv[2] || "runtime/rsshub");
  const manifest = await loadRsshubBuildManifest(process.argv[3]);
  const result = await verifyRsshubBuild(directory, manifest);
  console.log(JSON.stringify({ ok: true, build: "verified", ...result, dependencies: "not_checked" }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error && error.message.startsWith("RSSHub") ? error.message : "RSSHub构建校验失败，请核对独立运行目录与固定清单" }));
  process.exitCode = 1;
}
