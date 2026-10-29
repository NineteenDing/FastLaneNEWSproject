import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import { Conflict, audit } from "@aihot/backend/audit";
import { mediaCreatorPlatforms } from "./mediacrawler.ts";
import type { CreatorPlatform, PlatformSession } from "../contracts.ts";

const platformSchema = z.enum(["xhs", "douyin", "kuaishou", "bilibili", "weibo", "tieba", "zhihu"]);
type Row = { platform: CreatorPlatform; sealed_cookie: string | null; version: number; updated_at: Date };
const lock = (tx: Tx, platform: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${`studio.platform-session:${platform}`}, 0))`;
function key() {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) throw new Error("平台会话加密所需的服务器密钥未配置");
  return Buffer.from(hkdfSync("sha256", secret, "", "FastLaneNEWS/platform-session/v1", 32));
}
function seal(platform: string, value: string) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(`platform-session:${platform}`));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}
function open(row: Row) {
  if (!row.sealed_cookie) return "";
  const data = Buffer.from(row.sealed_cookie, "base64"), decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(`platform-session:${row.platform}`)); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
function overview(platform: CreatorPlatform, row?: Row): PlatformSession {
  let state: PlatformSession["state"] = row?.sealed_cookie ? "saved" : "missing";
  try { if (row?.sealed_cookie) open(row); } catch { state = "unreadable"; }
  return { platform, state, verified: false, version: row?.version ?? 0, updatedAt: row?.updated_at.toISOString() ?? null,
    adapterAvailable: mediaCreatorPlatforms.some(p => p === platform) };
}

/** Safe read model: never return Cookie, ciphertext, login identity or exception details. */
export async function platformSessions() {
  const rows = await sql<Row[]>`SELECT platform, sealed_cookie, version, updated_at FROM studio_platform_sessions`;
  const failures=await sql<{platform:string;failed:boolean}[]>`SELECT a.platform,bool_or(c.state='login_required' AND c.completed_at>s.updated_at) AS failed FROM studio_creator_accounts a JOIN studio_creator_collection c ON c.creator_id=a.id JOIN studio_platform_sessions s ON s.platform=a.platform GROUP BY a.platform`;
  return { rows: platformSchema.options.map(platform => ({...overview(platform, rows.find(row => row.platform === platform)),loginRequired:failures.find(f=>f.platform===platform)?.failed??false})) };
}
export async function savePlatformSession(platform: string, value: unknown, actor: string) {
  const parsed = platformSchema.parse(platform);
  const input = z.object({ version: z.number().int().nonnegative(), cookie: z.string().trim().max(16000).regex(/^[\x20-\x7e]*$/, "Cookie只能包含单行标准请求头字符")
    .refine(v => !v || /^[^\s:;=]+=.*/.test(v), "请粘贴Cookie值，不要包含Cookie:请求头名称") }).strict().parse(value);
  const sealed = input.cookie ? seal(parsed, input.cookie) : null;
  return sql.begin(async tx => {
    await lock(tx, parsed);
    const [before] = await tx<Row[]>`SELECT platform, sealed_cookie, version, updated_at FROM studio_platform_sessions WHERE platform = ${parsed} FOR UPDATE`;
    if ((before?.version ?? 0) !== input.version) throw new Conflict("平台会话已在其他窗口修改，请刷新后重新填写");
    const [saved] = await tx<Row[]>`INSERT INTO studio_platform_sessions (platform, sealed_cookie) VALUES (${parsed}, ${sealed})
      ON CONFLICT (platform) DO UPDATE SET sealed_cookie = EXCLUDED.sealed_cookie, version = studio_platform_sessions.version + 1, updated_at = now()
      RETURNING platform, sealed_cookie, version, updated_at`;
    await audit(actor, "studio.platform.session", `platform:${parsed}`, null, { configured: !!before?.sealed_cookie, version: before?.version ?? 0 },
      { configured: !!sealed, version: saved!.version }, { db: tx });
    return { session: overview(parsed, saved!) };
  });
}

/** Worker-only secret read. A missing/decryption-failed session is never a verified login. */
export async function platformSessionSecret(platform: CreatorPlatform) {
  const [row] = await sql<Row[]>`SELECT platform, sealed_cookie, version, updated_at FROM studio_platform_sessions WHERE platform = ${platform}`;
  try { return { cookie: row ? open(row) : "", version: row?.version ?? 0, readable: true }; }
  catch { return { cookie: "", version: row?.version ?? 0, readable: false }; }
}

/** Same transaction lock as save: also protects an initially absent session from concurrent creation. */
export async function platformSessionUnchanged(tx: Tx, platform: CreatorPlatform, version: number) {
  await lock(tx, platform);
  const [row] = await tx<{ version: number }[]>`SELECT version FROM studio_platform_sessions WHERE platform = ${platform}`;
  return (row?.version ?? 0) === version;
}
