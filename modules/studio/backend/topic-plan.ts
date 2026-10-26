import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { TopicPlan } from "../contracts.ts";

export const topicDurationMs = 48 * 3600_000;
const defaultPlan = { version: 0, enabled: false, startsAt: "2026-10-16T12:00:00.000Z" };

/** Latest private plan; reads never initialize settings or enqueue work. */
export async function topicPlan(db: typeof sql | Tx = sql): Promise<TopicPlan> {
  const [row] = await db<{ value: typeof defaultPlan | null; anchorLocked: boolean }[]>`
    SELECT (SELECT value FROM settings WHERE key = 'studio.topic.plan') AS value,
      EXISTS (SELECT 1 FROM studio_topic_batches) AS "anchorLocked"`;
  return { ...(row!.value ?? defaultPlan), anchorLocked: row!.anchorLocked, timeZone: "Asia/Hong_Kong", intervalHours: 48 };
}

export async function saveTopicPlan(input: unknown, actor: string) {
  const query = z.object({ version: z.number().int().min(0), enabled: z.boolean(), startsAt: z.iso.datetime() }).strict().parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    const before = await topicPlan(db);
    if (before.version !== query.version) throw new Conflict("选题计划已在其他窗口修改，请刷新后重试");
    const value = { version: before.version + 1, enabled: query.enabled, startsAt: new Date(query.startsAt).toISOString() };
    if (value.startsAt !== before.startsAt && before.anchorLocked)
      throw new Conflict("已有批次，不能移动两日边界；可暂停或恢复自动处理，历史保持不变");
    await db`INSERT INTO settings (key, value, updated_by) VALUES ('studio.topic.plan', ${db.json(value)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "studio.topic.plan.save", "settings:studio.topic.plan", null, before, value, { db });
    return topicPlan(db);
  });
}
