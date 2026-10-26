import { sql, type Db } from "../db.ts";

/** Durable execution slot shared by queue consumers and bounded interactive tasks. */
export async function claimExecutionLease(group: string, token: string, seconds: number, db: Db = sql) {
  if (!group || !token || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error("执行租约无效");
  const [claim] = await db`INSERT INTO module_queue_execution_leases (group_name, token, expires_at)
    VALUES (${group}, ${token}, now() + ${seconds} * interval '1 second')
    ON CONFLICT (group_name) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
    WHERE module_queue_execution_leases.expires_at <= now() RETURNING token`;
  return !!claim;
}
export async function releaseExecutionLease(group: string, token: string, db: Db = sql) {
  await db`DELETE FROM module_queue_execution_leases WHERE group_name = ${group} AND token = ${token}`;
}
