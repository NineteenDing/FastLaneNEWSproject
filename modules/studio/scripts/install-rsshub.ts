// Operator-only clean install. Does not activate it or start application/collection services.
import { parseArgs } from "node:util";
import { installRsshub } from "../backend/rsshub-install.ts";
import { loadRsshubBuildManifest } from "../backend/rsshub-build.ts";

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "runtime/rsshub" }, target: { type: "string" },
    store: { type: "string", default: "runtime/rsshub-store" }, pnpm: { type: "string" }, manifest: { type: "string" }, offline: { type: "boolean" } } });
  if (!values.target || !values.pnpm) throw new Error("RSSHub安装需要显式--target新目录和--pnpm固定工具入口");
  const result = await installRsshub({ sourceDirectory: values.source!, targetDirectory: values.target, storeDirectory: values.store!,
    pnpmCli: values.pnpm, manifest: await loadRsshubBuildManifest(values.manifest), offline: values.offline });
  console.log(JSON.stringify({ ok: true, ...result, activated: false }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error && error.message.startsWith("RSSHub") ? error.message : "RSSHub独立安装失败，请核对目录、固定工具及可用空间" }));
  process.exitCode = 1;
}
