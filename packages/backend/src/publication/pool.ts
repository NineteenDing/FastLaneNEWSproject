// Public pool (/all) with numeric pages, and search in its two orderings.
import type { GroupInfo, PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { one, sql, withCustomPlans, type Db } from "../db.ts";
import { cachedByKey, sharedSearch } from "../lib/cache.ts";
import {
  categoryCondition, channelCondition, ITEM_COLUMNS, ITEM_FROM, seatHolders, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { listedCondition, publicationNeedsRevalidation, browseWindowCondition, browseDayCondition, hasPreparedPublication, readingGroupKey } from "./scope.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeRow } from "./representative.ts";
import { TOPICS } from "./topics.ts";

export const POOL_PAGE_SIZE = 40;
export const POOL_MAX_PAGES = 50;

export class SearchBusyError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("search capacity exhausted");
    this.retryAfter = retryAfter;
  }
}

// Search capacity guard: bounded concurrency with a short queue. Overflow answers 503 + Retry-After
// instead of letting machine traffic drag list browsing down.
const MAX_CONCURRENT_SEARCHES = 4;
const MAX_QUEUED_SEARCHES = 8;
let running = 0;
const waiters: Array<() => void> = [];

export async function withSearchCapacity<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_SEARCHES) {
    if (waiters.length >= MAX_QUEUED_SEARCHES) throw new SearchBusyError(5);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new SearchBusyError(5));
      }, 3000);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(go);
    });
  }
  running += 1;
  try {
    return await withCustomPlans(fn);
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

/** Search terms: whitespace separated, lower-cased, LIKE metacharacters escaped. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[\\%_]/g, (m) => `\\${m}`));
}

/** Default search: subject, title or summary match (search_text), newest first. */
export function directMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  return terms.reduce((acc, t) => sql`${acc} AND p.search_text LIKE ${"%" + t + "%"}`, sql``);
}

const normalizeAlias = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The company a whole query names: a company topic's slug, full name,
 * each part of "OpenAI / ChatGPT" and its other names. Then the search also takes the articles about
 * that company (their subject tag), so "claude" finds Anthropic's news that never writes the word.
 * Only the whole query counts: "deepseek v4" stays a text search, not all of DeepSeek.
 */
function queryEntityTag(q: string): string | null {
  const want = normalizeAlias(q);
  if (!want) return null;
  const topic = TOPICS.find((t) => t.entityId && t.aliases.some((a) => normalizeAlias(a) === want));
  return topic ? `entity:${topic.entityId}` : null;
}

/**
 * The public APIs' q (v1 and MCP): every term matches the subject, title or summary, or the start of a
 * body whose full text may be shown, as the API documents it ("title / Chinese title / Chinese summary
 * / body"). Results stay in time order.
 */
export function publicMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  // Keep the body lookup correlated to the time-ordered candidates. Without OFFSET 0, PostgreSQL
  // may hash every matching body in pool_search before serving even the first 40 recent items.
  return terms.reduce(
    (acc, t) => sql`${acc} AND (p.search_text LIKE ${"%" + t + "%"} OR EXISTS (
      SELECT 1 FROM pool_search ps WHERE ps.article_id = p.article_id AND ps.body LIKE ${"%" + t + "%"} OFFSET 0))`,
    sql``,
  );
}

/** The listed items under the filters, up to the pages the pool offers. */
async function listedCount(f: TimelineFilters, now: Date): Promise<number> {
  return Number(one(await sql<{ n: number }[]>`
    SELECT count(*) AS n FROM (SELECT DISTINCT ${hasPreparedPublication() ? readingGroupKey() : sql`p.article_id`} FROM publications p WHERE ${listedCondition(now)}
      AND ${browseWindowCondition(now)}
      AND ${browseDayCondition(f.day, poolDate())}
      ${channelCondition(f.channel)} ${categoryCondition(f.category)} ${tagCondition(f.tag)} LIMIT ${POOL_MAX_PAGES * POOL_PAGE_SIZE}) t`).n);
}

/** Without a search the total only sets the page count: it is reused for 30 seconds per filter. */
const poolTotal = cachedByKey((f: TimelineFilters) => JSON.stringify([f.channel, f.category, f.tag, f.day]), (f) => listedCount(f, new Date()), { freshMs: 30_000, maxStaleMs: 30_000, maxKeys: 200 });

export interface PoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
  now?: Date;
}

/** Shared-event feeds use the persisted occurrence anchor, including for date filters and counts. */
const poolDate = () => hasPreparedPublication() ? sql`p.sort_at` : sql`p.timeline_at`;

// Identical searches share their read before taking search capacity.
const searchPool = sharedSearch(
  (q: PoolQuery) => JSON.stringify([q.channel, q.category, q.tag, q.q, q.tab, q.page, q.day]),
  queryPool, (q) => !!q.q?.trim(),
);

export function loadPool(query: PoolQuery): Promise<PoolResponse> {
  return searchPool(query, query.now);
}

async function queryPool(query: PoolQuery, now: Date): Promise<PoolResponse> {
  const page = Math.min(Math.max(query.page ?? 1, 1), POOL_MAX_PAGES);
  const q = query.q?.trim() || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  const terms = q ? searchTerms(q) : [];
  const entityTag = q ? queryEntityTag(q) : null;
  const filters = sql`AND ${browseWindowCondition(now)} AND ${browseDayCondition(query.day, poolDate())} ${channelCondition(query.channel)} ${categoryCondition(query.category)} ${tagCondition(query.tag)}`;
  const offset = (page - 1) * POOL_PAGE_SIZE;
  const cap = POOL_MAX_PAGES * POOL_PAGE_SIZE;
  const groupsByItem = new Map<string, GroupInfo>(), anchorsByItem = new Map<string, string>();

  // Searches go through pool_search (eligible items only): trigram indexes for longer terms, a small
  // table to scan for one- and two-character ones.
  const matchOrSubject = (text: ReturnType<typeof directMatchCondition>) => (entityTag ? sql`AND (p.tags @> ${[entityTag]}::text[] OR (TRUE ${text}))` : text);
  const like = (col: ReturnType<typeof sql>, t: string) => sql`${col} LIKE ${"%" + t + "%"}`;
  const run = async (db: Db) => {
    if (!q) {
      if (hasPreparedPublication()) {
        const pageGroups = await db<{ key: string; anchor: Date }[]>`SELECT ${readingGroupKey()} AS key, min(p.sort_at) AS anchor
          FROM publications p WHERE ${listedCondition(now)} ${filters}
          GROUP BY 1 ORDER BY anchor DESC, key DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}`;
        type Member = RepresentativeRow & { id: string; key: string; source_id: string; public_fact_id: string | null };
        const members = pageGroups.length ? await db<Member[]>`SELECT p.article_id AS id, ${readingGroupKey()} AS key, p.source_id, f.public_id AS public_fact_id,
          CASE WHEN s.site_fulltext THEN p.body_mode ELSE 'summary' END AS body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
          FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
          WHERE ${listedCondition(now)} ${filters} AND ${readingGroupKey()} = ANY(${pageGroups.map(group => group.key)}::text[])` : [];
        const representatives = pageGroups.flatMap(group => {
          const reports = members.filter(member => member.key === group.key); if (!reports.length) return [];
          const rep = pickRepresentative(reports); anchorsByItem.set(rep.id, group.anchor.toISOString());
          if (reports.length > 1 && rep.public_fact_id) groupsByItem.set(rep.id, { factId: rep.public_fact_id, reportCount: reports.length, dateBasis: "anchor",
            additionalSourceCount: new Set(reports.filter(report => report.source_id !== rep.source_id).map(report => report.source_id)).size });
          return [rep.id];
        });
        const hydrated = new Map(representatives.length ? (await db<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
          WHERE p.article_id = ANY(${representatives}::text[]) AND ${listedCondition(now)} ${filters}`).map(row => [row.id, row]) : []);
        return { rows: representatives.flatMap(id => hydrated.has(id) ? [hydrated.get(id)!] : []), total: await listedCount(query, now) };
      }
      // Page ids from the timeline index first, then the joins for those rows only.
      const rows = await db<ItemRow[]>`
        WITH page AS (
          SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} ${filters}
          ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
        SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
        ORDER BY p.timeline_at DESC, p.article_id DESC`;
      // A fixed clock (tests, replays) never shares cached totals.
      return { rows, total: query.now || publicationNeedsRevalidation() ? await listedCount(query, now) : await poolTotal(query) };
    }
    if (tab === "relevance") {
      // Rank narrow rows first: no article bodies or translations enter the sort/count. The public
      // total stops at 2,000, even though ranking must consider every matching item.
      // For an unfiltered trigram search, match each indexed field separately. OR across fields
      // can make PostgreSQL scan every toasted body instead. Keep other searches inline so short
      // terms, additional terms and selective publication filters retain their existing plans.
      const splitFields = terms.length === 1 && /[\p{L}\p{N}]{3}/u.test(terms[0]!)
        && (!query.channel || query.channel === "all") && !query.category && !query.tag;
      // Source edits queue a republish, but revoked full text must stop matching before that job runs.
      const bodyReadable = sql`EXISTS (SELECT 1 FROM publications licensed_p JOIN sources licensed_s ON licensed_s.id = licensed_p.source_id
        WHERE licensed_p.article_id = ps.article_id AND licensed_p.body_mode = 'full' AND licensed_s.site_fulltext)`;
      const partScore = terms.reduce(
        (acc, t) => sql`${acc} + (CASE WHEN ${like(sql`ps.direct`, t)} THEN 3 ELSE 0 END) + (CASE WHEN ${bodyReadable} AND ${like(sql`ps.body`, t)} THEN 1 ELSE 0 END)`,
        sql`0`,
      );
      const titleScore = terms.reduce((acc, t) => sql`${acc} + (CASE WHEN ${like(sql`lower(p.title)`, t)} THEN 6 ELSE 0 END)`, sql`0`);
      const anyMatch = terms.reduce((acc, t) => sql`${acc} AND (${like(sql`ps.direct`, t)} OR (${bodyReadable} AND ${like(sql`ps.body`, t)}))`, sql`TRUE`);
      const matches = splitFields ? sql`
        SELECT coalesce(d.article_id, b.article_id) AS article_id,
          (CASE WHEN d.article_id IS NOT NULL THEN 3 ELSE 0 END) + (CASE WHEN b.article_id IS NOT NULL THEN 1 ELSE 0 END) AS part
        FROM (SELECT article_id FROM pool_search WHERE direct LIKE ${"%" + terms[0]! + "%"}) d
        FULL JOIN (SELECT article_id FROM pool_search ps WHERE body LIKE ${"%" + terms[0]! + "%"} AND ${bodyReadable}) b ON b.article_id = d.article_id`
        : sql`SELECT ps.article_id, (${partScore}) AS part FROM pool_search ps WHERE ${anyMatch}`;
      type RankedRow = Omit<ItemRow, "id"> & { id: string | null; rel: number; total: number };
      // A query naming a company also takes the articles about it, ranked first.
      const scored = entityTag ? sql`
          SELECT p.article_id, p.timeline_at, max(matches.part) + (${titleScore}) + (CASE WHEN p.tags @> ${[entityTag]}::text[] THEN 10 ELSE 0 END) AS rel
          FROM (SELECT article_id, part FROM matches UNION ALL SELECT article_id, 0 FROM publications WHERE tags @> ${[entityTag]}::text[]) matches
          JOIN publications p ON p.article_id = matches.article_id
          WHERE ${listedCondition(now)} ${filters}
          GROUP BY p.article_id, p.timeline_at, p.title, p.tags` : sql`
          SELECT p.article_id, p.timeline_at, matches.part + (${titleScore}) AS rel
          FROM matches JOIN publications p ON p.article_id = matches.article_id JOIN sources s ON s.id = p.source_id
          WHERE ${listedCondition(now)} ${filters}`;
      const result = await db<RankedRow[]>`
        WITH matches AS ${splitFields ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (${matches}), scored AS MATERIALIZED (${scored}
        ), page AS MATERIALIZED (
          SELECT article_id, rel FROM scored ORDER BY rel DESC, timeline_at DESC, article_id DESC
          LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}
        ), total AS (SELECT count(*) AS n FROM (SELECT 1 FROM scored LIMIT ${cap}) capped)
        SELECT hydrated.*, total.n AS total FROM total LEFT JOIN LATERAL (
          SELECT ${ITEM_COLUMNS}, page.rel ${ITEM_FROM} JOIN page ON page.article_id = p.article_id
        ) hydrated ON true ORDER BY hydrated.rel DESC, hydrated.timeline_at DESC, hydrated.id DESC`;
      const rows = result.filter((r): r is ItemRow & { rel: number; total: number } => r.id !== null);
      return { rows, total: Number(result[0]!.total) };
    }
    // Default search: newest first straight from the timeline index; the total from the pool's
    // search rows, where one- and two-character terms scan a small table instead of every item.
    const rows = await db<ItemRow[]>`
      WITH page AS (
        SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} ${filters} ${matchOrSubject(directMatchCondition(terms))}
        ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
      SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
      ORDER BY p.timeline_at DESC, p.article_id DESC`;
    const direct = terms.reduce((acc, t) => sql`${acc} AND ${like(sql`ps.direct`, t)}`, sql``);
    const { n } = one(await db<{ n: number }[]>`
      SELECT count(*) AS n FROM (SELECT 1 FROM pool_search ps JOIN publications p ON p.article_id = ps.article_id
        WHERE ${listedCondition(now)} ${filters} ${matchOrSubject(direct)} LIMIT ${cap}) t`);
    return { rows, total: Number(n) };
  };

  const { rows, total } = q ? await withSearchCapacity(run) : await run(sql);
  const today = beijingDate(now);
  const meta = one(await sql<{ today_count: number; updated_at: Date | null }[]>`
    SELECT (SELECT ${hasPreparedPublication() && !q ? sql`count(DISTINCT ${readingGroupKey()})` : sql`count(*)`} FROM publications p
      WHERE ${listedCondition(now)} AND ${poolDate()} >= ${beijingMidnight(today)} ${filters}) AS today_count,
      (SELECT max(p.updated_at) FROM publications p WHERE ${listedCondition(now)}) AS updated_at`);

  const holders = await seatHolders(rows, now);
  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, q, tab, ...(query.day ? { day: query.day } : {}) },
    items: rows.map(r => {
      const item = toFeedItemSummary(r), group = groupsByItem.get(r.id), anchor = anchorsByItem.get(r.id);
      if (anchor) return { ...item, timelineAt: anchor, ...(group ? { group } : {}) };
      return holders.has(r.id) ? { ...item, reason: null, sameEvent: holders.get(r.id)! } : item;
    }),
    page,
    pageCount: Math.min(POOL_MAX_PAGES, Math.max(1, Math.ceil(total / POOL_PAGE_SIZE))),
    total,
    todayCount: Number(meta.today_count),
    freshness: (meta.updated_at ?? now).toISOString(),
  };
}
