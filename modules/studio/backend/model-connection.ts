import type { ModelProfile } from "./model-routing.ts";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import net from "node:net";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import { audit, Conflict } from "@aihot/backend/audit";
import { isBlockedAddress } from "@aihot/backend/lib/url";
import { STUDIO_MODEL, type ModelConnection } from "../contracts.ts";
import { modelWorkAllowed } from "./model-operations.ts";

const connectionKey = (profile: ModelProfile) => profile === "basic" ? "studio.model-basic-connection" : "studio.model-connection";
type Value = { version: number; baseUrl: string; analysisModel: string; qualityModel: string; sealedKey: string | null;
  analysisPrice?: ModelConnection["analysisPrice"]; qualityPrice?: ModelConnection["qualityPrice"]; visionModel?: string | null; visionPrice?: ModelConnection["visionPrice"] };
type Row = { value: Value; updated_at: Date };
/** Read old settings without rewriting secrets/history or carrying Pro/vision prices into Flash. */
function flashConnection(value: Value, profile: ModelProfile = "creative"): Value {
  if (profile === "basic") return { ...value, qualityModel: value.analysisModel, visionModel: null, visionPrice: null };
  const price = (value.analysisModel === STUDIO_MODEL ? value.analysisPrice : null)
    ?? (new URL(value.baseUrl).origin === "https://api.deepseek.com" ? { inputPerMillion: 2, outputPerMillion: 8 } : null);
  return { ...value, analysisModel: STUDIO_MODEL, qualityModel: STUDIO_MODEL, analysisPrice: price, qualityPrice: price,
    visionModel: value.visionModel ? STUDIO_MODEL : null, visionPrice: value.visionModel ? price : null };
}
const modelName = z.string().trim().min(1).max(160).regex(/^[\x21-\x7e]+$/, "模型名称只能包含不带空格的单行字符");
const priceSchema = z.object({ inputPerMillion: z.number().min(0).max(1_000_000), outputPerMillion: z.number().min(0).max(1_000_000) }).strict().nullable().optional();
const inputSchema = z.object({ version: z.number().int().nonnegative(),
  baseUrl: z.string().trim().min(1).max(2048).refine(value => {
    try {
      const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "");
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
        && (!net.isIP(host) || !isBlockedAddress(host)) && !/\/(?:chat\/completions|models)\/?$/.test(url.pathname);
    } catch { return false; }
  }, "请填写HTTPS API基础地址，不能包含密钥、查询参数、内网地址或具体接口路径").transform(value => new URL(value).toString().replace(/\/+$/, "")),
  analysisModel: modelName, qualityModel: modelName,
  visionModel: modelName.nullable().optional(), visionPrice: priceSchema,
  analysisPrice: priceSchema, qualityPrice: priceSchema,
  apiKey: z.string().max(4096).regex(/^[\x21-\x7e]*$/, "API Key只能包含不带空格的单行请求头字符").optional(),
}).strict();

// Adapted from this project's platform-sessions AES-GCM envelope; separate HKDF/AAD domain.
function encryptionKey() {
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) throw new Conflict("模型密钥加密所需的服务器密钥未配置");
  return Buffer.from(hkdfSync("sha256", secret, "", "FastLaneNEWS/model-connection/v1", 32));
}
function seal(value: string, profile: ModelProfile) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(connectionKey(profile)));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}
function open(value: string, profile: ModelProfile) {
  const data = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(connectionKey(profile))); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
async function overview(row?: Row, db: Db = sql, profile: ModelProfile = "creative"): Promise<ModelConnection> {
  const value = row ? flashConnection(row.value, profile) : undefined;
  const environmentConfigured = !row && profile === "creative" && !!credential("models", "LLM_BASE_URL") && !!credential("models", "LLM_API_KEY");
  let state: ModelConnection["state"] = row?.value.sealedKey ? "saved" : "missing";
  try { if (row?.value.sealedKey) open(row.value.sealedKey, profile); } catch { state = "unreadable"; }
  return { version: row?.value.version ?? 0, environmentConfigured, baseUrl: row?.value.baseUrl ?? (environmentConfigured ? credential("models", "LLM_BASE_URL")! : "https://api.deepseek.com/v1"),
    analysisModel: value?.analysisModel ?? (profile === "basic" ? "" : STUDIO_MODEL), qualityModel: value?.qualityModel ?? STUDIO_MODEL, state, verified: false,
    visionModel: value?.visionModel ?? null, visionPrice: value?.visionPrice ?? null,
    runtimeEnabled: await modelWorkAllowed(db), updatedAt: row?.updated_at.toISOString() ?? null,
    analysisPrice: value?.analysisPrice ?? null, qualityPrice: value?.qualityPrice ?? null };
}
/** Private safe read: opening settings makes no provider request and never exposes a key/envelope. */
export async function modelConnection(profile: ModelProfile = "creative"): Promise<ModelConnection> {
  const settingKey = connectionKey(profile);
  const [row] = await sql<Row[]>`SELECT value, updated_at FROM settings WHERE key = ${settingKey}`;
  return overview(row, sql, profile);
}
/** Worker-only connection read. Never called by the safe settings projection. */
export async function modelConnectionSecret(profile: ModelProfile = "creative") {
  const settingKey = connectionKey(profile);
  const [row] = await sql<Row[]>`SELECT value, updated_at FROM settings WHERE key = ${settingKey}`;
  if (!row) return null;
  if (!row.value.sealedKey) throw new Conflict("模型连接尚未填写API Key");
  try { return { ...flashConnection(row.value, profile), apiKey: open(row.value.sealedKey, profile) }; }
  catch { throw new Conflict("模型密钥无法解密，请重新保存API Key"); }
}
export async function saveModelConnection(value: unknown, actor: string, profile: ModelProfile = "creative") {
  const settingKey = connectionKey(profile);
  const input = inputSchema.parse(value);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${settingKey}, 0))`;
    const [before] = await tx<Row[]>`SELECT value, updated_at FROM settings WHERE key = ${settingKey} FOR UPDATE`;
    if ((before?.value.version ?? 0) !== input.version) throw new Conflict("模型连接已在其他窗口修改，请刷新后重新填写");
    if (input.apiKey === undefined && before?.value.sealedKey) {
      try { open(before.value.sealedKey, profile); } catch { throw new Conflict("模型密钥无法解密，请重新填写API Key"); }
      if (new URL(before.value.baseUrl).origin !== new URL(input.baseUrl).origin) throw new Conflict("更换服务地址时请重新填写API Key");
    }
    if (input.apiKey === undefined && !before?.value.sealedKey) throw new Conflict("请填写API Key");
    const sealedKey = input.apiKey === undefined ? before!.value.sealedKey : input.apiKey ? seal(input.apiKey, profile) : null;
    const sameService = before?.value.baseUrl === input.baseUrl;
    const visionModel = input.visionModel !== undefined ? input.visionModel : sameService ? before?.value.visionModel ?? null : null;
    const stored = flashConnection({ version: input.version + 1, baseUrl: input.baseUrl,
      analysisModel: profile === "basic" ? input.analysisModel : STUDIO_MODEL, qualityModel: STUDIO_MODEL, sealedKey, visionModel,
      analysisPrice: input.analysisPrice !== undefined ? input.analysisPrice : sameService && before ? flashConnection(before.value, profile).analysisPrice : null }, profile);
    const [saved] = await tx<Row[]>`INSERT INTO settings (key, value, updated_by) VALUES (${settingKey}, ${tx.json(stored)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING value, updated_at`;
    await audit(actor, "studio.model.connection", `studio:model-connection:${profile}`, null,
      { version: before?.value.version ?? 0, configured: !!before?.value.sealedKey }, { version: stored.version, configured: !!sealedKey }, { db: tx });
    return overview(saved!, tx, profile);
  });
}
