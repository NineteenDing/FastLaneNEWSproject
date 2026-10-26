import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { addDays, beijingAt, beijingDate, isValidDate } from "@aihot/contracts/time";
import { feedbackSourceHash } from "@aihot/backend/operations/feedback";

const recent = new Map<string, { at: number; count: number }>();
export function allowVisit(ip: string, userAgent: string) {
  const at = Date.now(), key = feedbackSourceHash(ip, userAgent), prior = recent.get(key);
  if (prior && at - prior.at < 60000) return ++prior.count <= 300;
  if (recent.size >= 5000) for (const [key, value] of recent) if (at - value.at >= 60000) recent.delete(key);
  if (recent.size >= 5000) return false;
  recent.set(key, { at, count: 1 }); return true;
}

const publicPath = /^\/(?:|all|hot|daily(?:\/[^/?#]{1,160})?|items\/[^/?#]{1,160}(?:\/original)?|story\/[^/?#]{1,160}|starred|film\/(?:domestic|overseas)|about|changelog|feedback|more|privacy|terms)$/;
const visit = z.object({ id: z.uuid(), visitorId: z.uuid(), sessionId: z.uuid(), path: z.string().max(300).regex(publicPath), activeMs: z.number().int().min(0).max(86400000) }).strict();

/** Anonymous cumulative heartbeats: retries never add the same duration twice. */
export async function recordVisit(input: unknown) {
  const value = visit.parse(input), at = new Date();
  await sql`INSERT INTO studio_visits (id, visitor_id, session_id, path, started_at, updated_at, active_ms)
    VALUES (${value.id}, ${value.visitorId}, ${value.sessionId}, ${value.path}, ${at}, ${at}, 0)
    ON CONFLICT (id) DO UPDATE SET active_ms = greatest(studio_visits.active_ms, least(${value.activeMs},
      greatest(0, extract(epoch FROM (${at}::timestamptz - studio_visits.started_at)) * 1000)::bigint,
      studio_visits.active_ms + greatest(0, extract(epoch FROM (${at}::timestamptz - studio_visits.updated_at)) * 1000)::bigint)),
      updated_at = greatest(studio_visits.updated_at, ${at})
    WHERE studio_visits.visitor_id = EXCLUDED.visitor_id AND studio_visits.session_id = EXCLUDED.session_id AND studio_visits.path = EXCLUDED.path`;
}

export async function visitorStats(input: unknown) {
  const today = beijingDate(new Date()), date = z.string().refine(isValidDate, "日期无效");
  const range = z.object({ from: date.default(addDays(today, -6)), to: date.default(today) }).strict().refine(value => value.from <= value.to && (Date.parse(value.to) - Date.parse(value.from)) / 86400000 <= 366, "请选择不超过367天的有效日期范围").parse(input);
  const from = beijingAt(range.from, "00:00"), to = beijingAt(addDays(range.to, 1), "00:00");
  return sql.begin("isolation level repeatable read read only", async db => {
    const where = db`started_at >= ${from} AND started_at < ${to}`;
    const [overview] = await db`SELECT count(*)::int AS "pageViews", count(DISTINCT visitor_id)::int AS visitors, count(DISTINCT session_id)::int AS visits,
      coalesce(sum(active_ms), 0)::float8 AS "activeMs", coalesce(sum(active_ms)::float8 / nullif(count(DISTINCT session_id),0),0) AS "averageVisitMs" FROM studio_visits WHERE ${where}`;
    const daily = await db`SELECT to_char(started_at AT TIME ZONE 'Asia/Hong_Kong', 'YYYY-MM-DD') AS day, count(*)::int AS "pageViews", count(DISTINCT visitor_id)::int AS visitors,
      coalesce(sum(active_ms),0)::float8 AS "activeMs" FROM studio_visits WHERE ${where} GROUP BY day ORDER BY day DESC`;
    const pages = await db`SELECT path, count(*)::int AS "pageViews", count(DISTINCT visitor_id)::int AS visitors, coalesce(sum(active_ms),0)::float8 AS "activeMs",
      coalesce(avg(active_ms),0)::float8 AS "averageMs" FROM studio_visits WHERE ${where} GROUP BY path ORDER BY "activeMs" DESC, "pageViews" DESC, path LIMIT 50`;
    return { ...range, overview, daily, pages };
  });
}
