import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import type { SourceCoveragePage, SourceCoverageSnapshot, SourceCoverageRow } from "../contracts.ts";

const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
type SavedSource = Omit<SourceCoverageRow, "state" | "lastCheckedAt" | "lastAttemptAt"> & {
  lastCheckedAt: Date | null; lastAttemptAt: Date | null; savedState: string | null;
};

/** Read existing collection metadata only. A successful request never proves all posts/comments were obtained. */
export async function captureSourceCoverage(db: Db, window: { startsAt: Date; endsAt: Date }): Promise<SourceCoverageSnapshot> {
  const saved = await db<SavedSource[]>`SELECT 'news:' || s.id AS id, s.name,
      CASE WHEN b.source_id IS NULL THEN 'news' ELSE 'trend' END AS kind, coalesce(b.platform, 'news') AS platform,
      s.enabled, s.last_ok_at AS "lastCheckedAt", s.last_fetch_at AS "lastAttemptAt", NULL::boolean AS "pagesComplete", NULL::int AS page, NULL::int AS "nextPage",
      CASE WHEN t.platform IS NOT NULL THEN t.state WHEN s.last_error IS NOT NULL THEN 'failed' END AS "savedState"
    FROM sources s LEFT JOIN studio_trend_boards b ON b.source_id = s.id
    LEFT JOIN studio_trend_collection t ON t.platform = b.platform WHERE NOT s.archived
    UNION ALL SELECT 'creator:' || c.id, coalesce(c.name, c.locator), 'creator', c.platform, c.enabled,
      c.last_checked_at, coalesce(j.completed_at, j.started_at), (j.coverage->>'complete')::boolean,
      (j.coverage->>'page')::int, (j.coverage->>'nextPage')::int, j.state
    FROM studio_creator_accounts c LEFT JOIN studio_creator_collection j ON j.creator_id = c.id
    WHERE c.following AND NOT c.archived
    ORDER BY kind, name, id`;
  const counts: SourceCoverageSnapshot["counts"] = { paused: 0, not_checked: 0, checked: 0, partial: 0, running: 0, failed: 0, login_required: 0, rate_limited: 0, interrupted: 0, after_window: 0 };
  const rows = saved.map(row => {
    const { savedState, lastCheckedAt, lastAttemptAt, ...source } = row;
    let state: SourceCoverageRow["state"];
    if (!row.enabled) state = "paused";
    else if (["running", "failed", "login_required", "rate_limited", "interrupted"].includes(savedState ?? "")) state = savedState as SourceCoverageRow["state"];
    else if (!lastCheckedAt || lastCheckedAt < window.startsAt) state = "not_checked";
    else if (lastCheckedAt >= window.endsAt) state = "after_window";
    else state = row.pagesComplete === false ? "partial" : "checked";
    counts[state]++;
    return { ...source, lastCheckedAt: lastCheckedAt?.toISOString() ?? null, lastAttemptAt: lastAttemptAt?.toISOString() ?? null, state };
  });
  return { policy: "studio-source-coverage-v1", capturedAt: new Date().toISOString(), startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(), counts, rows };
}
function project(snapshot: SourceCoverageSnapshot | null, state: SourceCoveragePage["state"], input: unknown): SourceCoveragePage {
  const query = pagination.parse(input), total = snapshot?.rows.length ?? 0, offset = (query.page - 1) * query.limit;
  return { state, capturedAt: snapshot?.capturedAt ?? null, startsAt: snapshot?.startsAt ?? null, endsAt: snapshot?.endsAt ?? null,
    counts: snapshot?.counts ?? null, rows: snapshot?.rows.slice(offset, offset + query.limit) ?? [], total, page: query.page, hasMore: offset + query.limit < total };
}
export async function currentSourceCoverage(window: { startsAt: string; endsAt: string }, input: unknown) {
  pagination.parse(input);
  const snapshot = await sql.begin("isolation level repeatable read read only", db => captureSourceCoverage(db, { startsAt: new Date(window.startsAt), endsAt: new Date(window.endsAt) }));
  return project(snapshot, "current", input);
}
export async function frozenSourceCoverage(id: string, input: unknown) {
  z.uuid().parse(id); pagination.parse(input);
  const [row] = await sql<{ snapshot: SourceCoverageSnapshot | null }[]>`SELECT source_coverage AS snapshot FROM studio_topic_batches WHERE id = ${id}`;
  return row ? project(row.snapshot, row.snapshot ? "snapshot" : "unavailable", input) : null;
}
