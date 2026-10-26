// Local operator command: read only the isolated restore, never the original database/dump.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";

const root = path.resolve(import.meta.dirname, "../../..");
let source: ReturnType<typeof postgres> | undefined;
let closeTarget: (() => Promise<void>) | undefined;
try {
  const env = parseEnv(await readFile(process.env.STUDIO_LOCAL_ENV || path.join(root, ".env"), "utf8"));
  let target: URL;
  try {
    target = new URL(env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "[::1]"].includes(target.hostname)
      || target.search || target.hash || target.pathname !== "/studio_local") throw new Error();
  } catch { throw new Error("LOCAL_DATABASE_REFUSED"); }
  const restored = new URL(target); restored.pathname = "/studio_import";
  source = postgres(restored.toString(), { max: 1, connect_timeout: 3, onnotice: () => {},
    connection: { default_transaction_read_only: true, statement_timeout: 10000 } });
  const sources = await source`
    SELECT id, name, kind, config, tags, enabled, tier, first_party, participation_mode,
      signal_group_id, owner_entity_id, interval_minutes, site_fulltext, syndicate_fulltext, icon_url, created_at
    FROM sources ORDER BY id LIMIT 5001`;
  if (sources.length === 0) throw new Error("IMPORT_SOURCE_EMPTY");
  // Backend imports happen only after replacing inherited credentials/config with the validated target.
  const safe = localProcessEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safe, { DATABASE_URL: target.toString(), COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
    AIHOT_CREDENTIALS_DIR: path.join(root, ".local/no-import-credentials") });
  const { closeDb } = await import("@aihot/backend/db");
  closeTarget = closeDb;
  const { importNewsSources } = await import("../backend/import-news.ts");
  const result = await importNewsSources({ sources }, "local:source-import");
  console.log(JSON.stringify({ ok: true, source: "studio_import", target: "studio_local", found: sources.length, ...result }));
} catch (error) {
  const allowed = ["LOCAL_DATABASE_REFUSED", "IMPORT_SOURCE_EMPTY"];
  const code = error instanceof Error && allowed.includes(error.message) ? error.message : "SOURCE_IMPORT_FAILED";
  console.log(JSON.stringify({ ok: false, code, message: "来源导入未完成，请检查本项目配置、隔离副本及数据格式。原始来源未修改。" }));
  process.exitCode = 1;
} finally {
  await source?.end({ timeout: 1 });
  await closeTarget?.();
}
