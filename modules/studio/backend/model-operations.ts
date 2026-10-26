import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { audit, Conflict } from "@aihot/backend/audit";
import type { ModelOperations } from "../contracts.ts";

const key = "studio.model.operations";
type Value = { version: number; enabled: boolean };

/** The environment is the operator ceiling; a private persisted pause applies across processes. */
export async function modelOperations(db: Db = sql): Promise<ModelOperations> {
  const [row] = await db<{ value: Value; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = ${key}`;
  const requestedEnabled = row?.value.enabled ?? true;
  return { version: row?.value.version ?? 0, requestedEnabled, runtimeAllowed: config.modelCallsEnabled,
    enabled: config.modelCallsEnabled && requestedEnabled, updatedAt: row?.updated_at.toISOString() ?? null };
}
export async function modelWorkAllowed(db?: Db) {
  return config.modelCallsEnabled && (await modelOperations(db)).enabled;
}
export async function saveModelOperations(input: unknown, actor: string) {
  const query = z.object({ version: z.number().int().nonnegative(), enabled: z.boolean() }).strict().parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const [before] = await db<{ value: Value }[]>`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`;
    if ((before?.value.version ?? 0) !== query.version) throw new Conflict("模型运行设置已在其他窗口修改，请刷新后重试");
    if (query.enabled && !config.modelCallsEnabled) throw new Conflict("启动配置尚未允许模型调用，请先配置运行开关并重启服务");
    const value = { version: query.version + 1, enabled: query.enabled };
    const [saved] = await db<{ updated_at: Date }[]>`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${db.json(value)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING updated_at`;
    await audit(actor, "studio.model.operations", key, null, before?.value ?? null, value, { db });
    return { version: value.version, requestedEnabled: value.enabled, runtimeAllowed: config.modelCallsEnabled,
      enabled: config.modelCallsEnabled && value.enabled, updatedAt: saved!.updated_at.toISOString() } satisfies ModelOperations;
  });
}
