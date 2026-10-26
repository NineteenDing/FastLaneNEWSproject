import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { HistorySettings } from "../contracts.ts";

const defaultSettings: HistorySettings = { version: 0, candidateLimit: 50, evidenceLimit: 10 };
export async function historySettings(db: Db = sql): Promise<HistorySettings> {
  const [row] = await db<{ value: HistorySettings }[]>`SELECT value FROM settings WHERE key = 'studio.history.settings'`;
  return row?.value ?? defaultSettings;
}

export async function saveHistorySettings(input: unknown, actor: string) {
  const value = z.object({ version: z.number().int().nonnegative(), candidateLimit: z.number().int().min(1).max(50),
    evidenceLimit: z.number().int().min(1).max(10) }).strict().refine(value => value.evidenceLimit <= value.candidateLimit).parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.history.settings', 0))`;
    const before = await historySettings(db);
    if (before.version !== value.version) throw new Conflict("历史关联设置已在其他窗口修改，请刷新后重试");
    const next = { ...value, version: before.version + 1 };
    await db`INSERT INTO settings (key, value, updated_by) VALUES ('studio.history.settings', ${db.json(next)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "studio.history.settings.save", "settings:studio.history.settings", null, before, next, { db });
    return next;
  });
}
