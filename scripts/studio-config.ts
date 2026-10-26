import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import postgres from "postgres";

export class LocalError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Same validation in the operator and the new owned root; a reread cannot bypass database safety. */
export async function readLocalConfiguration(file: string) {
  const env = parseEnv(await readFile(file, "utf8"));
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL ?? "");
    const name = decodeURIComponent(database.pathname.slice(1));
    if (!["postgres:", "postgresql:"].includes(database.protocol) || !["127.0.0.1", "[::1]"].includes(database.hostname)
      || database.search || database.hash || !(name === "studio_local" || /_(test|ci)$/.test(name))) throw new Error();
  } catch {
    throw new LocalError("LOCAL_DATABASE_REFUSED", "本机工具只允许回环地址上的 studio_local 或独立测试数据库，且连接地址不能含查询参数。");
  }
  const sql = postgres(database.toString(), { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 3000 } });
  try { await sql`SELECT 1`; }
  catch { throw new LocalError("LOCAL_DATABASE_UNAVAILABLE", "本项目数据库无法连接，请检查独立 PostgreSQL 是否已启动及连接配置。"); }
  finally { await sql.end({ timeout: 1 }); }
  return { env, database };
}
