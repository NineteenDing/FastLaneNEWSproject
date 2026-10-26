import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

const groups = ["model-request:1", "model-request:2"] as const;

/** Shared durable execution slots, not one semaphore per model, queue or process.
 * No connection remains checked out while a provider is running. */
export async function withModelRequest<T>(timeoutMs: number, beforeCall: (() => Promise<void>) | undefined,
  run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid model request timeout");
  const token = randomUUID();
  let group: string | undefined, remaining = timeoutMs;
  while (!group) {
    shutdownSignal.signal.throwIfAborted();
    await beforeCall?.();
    const claimStarted = performance.now();
    group = await sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout = 3000`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('model-request-slots'))`;
      for (const candidate of groups) {
        const [claimed] = await tx`INSERT INTO module_queue_execution_leases (group_name, token, expires_at)
          VALUES (${candidate}, ${token}, clock_timestamp() + ${timeoutMs + 195000} * interval '1 millisecond')
          ON CONFLICT (group_name) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
          WHERE module_queue_execution_leases.expires_at <= now() RETURNING group_name`;
        if (claimed) return candidate;
      }
      return undefined;
    });
    if (group) remaining = timeoutMs - Math.ceil(performance.now() - claimStarted);
    if (!group) await delay(250, undefined, { signal: shutdownSignal.signal });
  }
  // The whole admitted call has one deadline, including receipt preparation. A delayed
  // database must never allow HTTP to start after the durable slot's safety margin.
  try {
    if (remaining <= 0) throw new Error("Model request deadline elapsed while claiming execution slot");
    const signal = AbortSignal.timeout(remaining);
    shutdownSignal.signal.throwIfAborted(); await beforeCall?.(); return await run(signal);
  }
  finally {
    try { await sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout = 3000`;
      await tx`DELETE FROM module_queue_execution_leases WHERE group_name = ${group!} AND token = ${token}`;
    }); }
    catch { console.error("[model-request] execution slot release deferred until its bounded expiry"); }
  }
}

export async function modelRequestStatus() {
  const [{ occupied }] = await sql<{ occupied: number }[]>`SELECT count(*)::int AS occupied FROM module_queue_execution_leases
    WHERE group_name IN ${sql(groups)} AND expires_at > now()`;
  return { limit: 2, occupied: occupied! };
}
