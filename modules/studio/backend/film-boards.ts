import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { IMAGE_WIDTHS } from "@aihot/backend/media/renditions";
import { scanImageFiles } from "./image-files.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { Conflict, audit } from "@aihot/backend/audit";
import type { FilmBoard, FilmBoardItem, FilmBoardSnapshot, FilmBoardsPage } from "../film-boards-contracts.ts";
import { filmBoardCatalog } from "./film-board-catalog.ts";
import { defineQueue } from "@aihot/backend/modules";
import { ensureQueue, enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { beijingAt, beijingDate } from "@aihot/contracts/time";
import { createCollectionAdmission } from "./collection-admission.ts";
import { filmTextKey, savedFilmTranslations, submitFilmTranslation } from "./film-translation.ts";
import { readFilmBoard } from "./film-board-reader.ts";

const settings = z.object({ version: z.number().int().nonnegative(), enabled: z.boolean(), limit: z.number().int().min(1).max(100) }).strict();
type Saved = { id: string; version: number; definition: { enabled: boolean; limit: number }; snapshot: FilmBoardSnapshot | null;
  state: FilmBoard["state"]; error_code: string | null; checked_at: Date | null };
type Job = { id: string; version: number; token: string };
const heatMetricNames = new Set(["热度", "来源综合热度", "read_count（来源观看计数）", "viewCount（来源观看计数）", "VertiScore（来源综合评分）"]);
const heatMetrics = (metrics: FilmBoardItem["metrics"]) => metrics.filter(metric => heatMetricNames.has(metric.name));

export const filmBoardQueue = defineQueue<Job>({ name: "studio.film.collect",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 120 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission(), async run(jobs) { for (const job of jobs) await collect(job); },
});

/** Only saved snapshots are read. This path never requests a platform or a model. */
export async function filmBoards(input: unknown = {}): Promise<FilmBoardsPage> {
  const { region, includeRetired } = z.object({ region: z.enum(["domestic", "overseas"]).optional(), includeRetired: z.boolean().optional() }).strict().parse(input);
  const saved = await sql<Saved[]>`SELECT id, version, definition, snapshot, state, error_code, checked_at FROM studio_film_boards`;
  const translations = await savedFilmTranslations(saved.flatMap(row => {
    const board = filmBoardCatalog.find(board => board.id === row.id);
    return board?.region === "overseas" ? row.snapshot?.items.slice(0, board.limit ?? 20) ?? [] : [];
  }));
  const byId = new Map(saved.map(row => [row.id, row]));
  // Retired sources keep their snapshots in storage but no longer appear in the public/admin navigation.
  return { boards: filmBoardCatalog.filter(board => (includeRetired || !board.retired) && (!region || board.region === region)).map(board => {
    const row = byId.get(board.id), limit = board.limit ?? 20, definition = row?.definition ?? { enabled: true, limit };
    return { ...board, ...definition, limit, version: row?.version ?? 0,
      state: !board.supported ? "not_connected" : !definition.enabled ? "paused" : row?.state ?? "pending",
      error: row?.error_code ?? null, checkedAt: row?.checked_at?.toISOString() ?? null,
      snapshotAt: row?.snapshot?.fetchedAt ?? null, sourceUpdatedText: row?.snapshot?.sourceUpdatedText ?? null,
      requestedLimit: row?.snapshot ? row.snapshot.requestedLimit : null,
      ...(row?.snapshot?.sourceIssueDate !== undefined ? { sourceIssueDate: row.snapshot.sourceIssueDate } : {}),
      ...(row?.snapshot?.sourceTotal !== undefined ? { sourceTotal: row.snapshot.sourceTotal } : {}),
      ...(row?.snapshot?.categories ? { categories: row.snapshot.categories } : {}),
      ...(row?.snapshot?.platforms ? { platforms: row.snapshot.platforms } : {}),
      items: (row?.snapshot?.items ?? []).slice(0, limit).map(item => ({ id: item.id, position: item.position, title: item.title, url: item.url, author: item.author,
        sourceSummary: item.sourceSummary ?? null, ...(item.genreKeys ? { genreKeys: item.genreKeys } : {}),
        ...(item.sourcePlatform ? { sourcePlatform: item.sourcePlatform, sourcePlatformLabel: item.sourcePlatformLabel ?? null } : {}),
        ...(item.productionCountries ? { productionCountries: item.productionCountries, countryStatus: item.countryStatus } : {}),
        ...(item.summaryKind ? { summaryKind: item.summaryKind, summaryStatus: item.summaryStatus } : {}),
        ...(board.region === "overseas" ? { titleZh: translations.get(filmTextKey(item))?.title_zh ?? null, summaryZh: translations.get(filmTextKey(item))?.summary_zh ?? null } : {}),
        metrics: heatMetrics(item.metrics) })) };
  }) };
}

export async function filmBoardImageAllowed(_url: string) { return false; }

export async function submitFilmBoard(id: string, actor: string) {
  const board = filmBoardCatalog.find(board => board.id === id);
  if (!board?.supported) throw new Conflict("暂未接入这个榜单的数据接口");
  if (!collectionEnabled()) throw new Conflict("采集尚未启用");
  await ensureQueue(filmBoardQueue.name, filmBoardQueue.options);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${"studio.film-board:" + id}, 0))`;
    await db`INSERT INTO studio_film_boards (id, definition) VALUES (${id}, ${db.json({ enabled: true, limit: board.limit ?? 20 })}) ON CONFLICT DO NOTHING`;
    const [row] = await db<Array<Saved & { job_id: string | null }>>`SELECT id, version, definition, job_id FROM studio_film_boards WHERE id = ${id} FOR UPDATE`;
    if (!row?.definition.enabled) throw new Conflict("请先启用该榜单采集");
    if (row.job_id && (await db`SELECT 1 FROM pgboss.job WHERE name = ${filmBoardQueue.name} AND id = ${row.job_id} AND state IN ('created', 'retry', 'active')`).length) return { queued: false };
    // localConcurrency 1 already serializes collections; avoiding a persistent group key prevents a killed
    // worker from leaving every future film collection unfetchable.
    const token = randomUUID(), jobId = await enqueueOn(filmBoardQueue, { id, version: row.version, token }, { singletonKey: id }, db);
    if (!jobId) return { queued: false };
    await db`UPDATE studio_film_boards SET state = 'queued', run_token = ${token}, job_id = ${jobId}, error_code = NULL, updated_at = now() WHERE id = ${id}`;
    await audit(actor, "studio.film-board.collect", `studio.film-board:${id}`, null, null, { queued: true, db });
    return { queued: true };
  });
}

export async function scheduleFilmBoards(now = new Date()) {
  if (!collectionEnabled()) return { queued: 0 };
  const cutoff = beijingAt(beijingDate(now), "07:00"), domesticDue = now >= cutoff;
  // Vertical Charts publishes Thursday 09:00 ET; check after 09:15 New York time, with bounded catch-up checks.
  const ny = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map(part => [part.type, part.value]));
  const nyMinutes = Number(ny.hour) * 60 + Number(ny.minute);
  const verticalDue = (ny.weekday === "Thu" && nyMinutes >= 9 * 60 + 15) || (["Fri", "Sat"].includes(ny.weekday ?? "") && nyMinutes >= 9 * 60 + 15);
  const saved = await sql<Saved[]>`SELECT id, definition, checked_at FROM studio_film_boards`;
  let queued = 0;
  for (const board of filmBoardCatalog.filter(board => board.supported && !board.retired)) {
    const row = saved.find(row => row.id === board.id);
    if (row && !row.definition.enabled) continue;
    if (board.region === "overseas") {
      if (!verticalDue || row?.checked_at && now.getTime() - row.checked_at.getTime() < 20 * 3600_000) continue;
    } else if (!domesticDue || row?.checked_at && row.checked_at >= cutoff) continue;
    if ((await submitFilmBoard(board.id, "system:film-boards"))?.queued) queued++;
  }
  return { queued };
}

async function collect(job: Job) {
  if (!collectionEnabled()) throw new QueueDeferred("采集已暂停");
  const [row] = await sql<Saved[]>`UPDATE studio_film_boards SET state = 'running', started_at = now(), updated_at = now()
    WHERE id = ${job.id} AND version = ${job.version} AND run_token = ${job.token} AND state = 'queued' AND (definition->>'enabled')::boolean
    RETURNING id, version, definition`;
  if (!row) return;
  try {
    const snapshot = await readFilmBoard(job.id);
    if (!collectionEnabled()) { await sql`UPDATE studio_film_boards SET state = 'pending' WHERE id = ${job.id} AND run_token = ${job.token}`; return; }
    await sql`UPDATE studio_film_boards SET snapshot = ${sql.json(snapshot as never)}, state = ${snapshot.items.length ? "ready" : "empty"}, display_policy_version = 1,
      checked_at = now(), error_code = NULL, updated_at = now() WHERE id = ${job.id} AND version = ${job.version} AND run_token = ${job.token}`;
  } catch {
    await sql`UPDATE studio_film_boards SET state = ${collectionEnabled() ? "failed" : "pending"}, checked_at = now(),
      error_code = ${collectionEnabled() ? "获取未完成，保留最后成功结果；可重试。" : null}, updated_at = now()
      WHERE id = ${job.id} AND version = ${job.version} AND run_token = ${job.token}`;
    return;
  }
  // Translation is independent: an enqueue failure must not mark a saved collection as failed.
  await submitFilmTranslation(job.id);
}

export async function saveFilmBoard(id: string, input: unknown, actor: string) {
  const board = filmBoardCatalog.find(board => board.id === id);
  if (!board) throw new Conflict("未找到这个影视榜单");
  const value = settings.parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${"studio.film-board:" + id}, 0))`;
    const [before] = await db<Saved[]>`SELECT id, version, definition, snapshot, state, error_code, checked_at FROM studio_film_boards WHERE id = ${id} FOR UPDATE`;
    if ((before?.version ?? 0) !== value.version) throw new Conflict("榜单设置已在其他窗口修改，请刷新后重试");
    const definition = { enabled: value.enabled, limit: board.limit ?? value.limit }, version = value.version + 1;
    await db`INSERT INTO studio_film_boards (id, version, definition, run_token) VALUES (${id}, ${version}, ${db.json(definition)}, ${randomUUID()})
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, definition = EXCLUDED.definition, run_token = EXCLUDED.run_token, state = 'pending', error_code = NULL, updated_at = now()`;
    await audit(actor, "studio.film-board.save", `studio.film-board:${id}`, null, before?.definition ?? null, definition, { db });
    return { ...definition, version };
  });
}

/** Bounded startup reconciliation: retire old oversized/image snapshots and their disposable renditions. */
export async function minimizeLegacyFilmBoards() {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('studio-storage-space'))`;
    const rows = await tx<Array<{ id: string; definition: { enabled: boolean }; snapshot: FilmBoardSnapshot | null }>>`SELECT id, definition, snapshot FROM studio_film_boards WHERE display_policy_version = 0 ORDER BY id LIMIT 25 FOR UPDATE`;
    if (!rows.length) return;
    const covers = [...new Set(rows.flatMap(row => (row.snapshot?.items ?? []).flatMap(item => (item as unknown as { coverUrl?: string }).coverUrl ?? [])))];
    // imgcache is shared. Preserve even private/withdrawn news references, not only currently public images.
    const shared = covers.length ? await tx<{ url: string }[]>`SELECT candidate.url FROM unnest(${covers}::text[]) candidate(url)
      WHERE EXISTS (SELECT 1 FROM articles WHERE strpos(media::text, candidate.url) > 0 OR strpos(coalesce(x_post::text,''), candidate.url) > 0
        OR strpos(coalesce(body_html,''), candidate.url) > 0 OR strpos(coalesce(body_html,''), replace(candidate.url, '&', '&amp;')) > 0)
      OR EXISTS (SELECT 1 FROM sources WHERE icon_url = candidate.url)
      OR EXISTS (SELECT 1 FROM studio_public_news WHERE decision->'images' ? candidate.url OR decision->'fulltextImages' ? candidate.url)` : [];
    const sharedUrls = new Set(shared.map(row => row.url)), cacheKeys = new Set<string>();
    for (const row of rows) for (const item of row.snapshot?.items ?? []) {
      const legacy = item as unknown as { coverUrl?: string };
      if (!legacy.coverUrl || sharedUrls.has(legacy.coverUrl)) continue;
      for (const mode of [...Object.keys(IMAGE_WIDTHS), "default"]) {
        const key = createHash("sha256").update(mode + "|" + legacy.coverUrl).digest("hex");
        const file = path.join(config.dataDir, "imgcache", key.slice(0, 2), key);
        for (const suffix of ["", ".type", ".prepared"]) cacheKeys.add(file + suffix);
      }
    }
    if (cacheKeys.size) for (const [file] of await scanImageFiles(["imgcache"])) if (cacheKeys.has(file)) await unlink(file);
    for (const row of rows) {
      const snapshot = row.snapshot ? { ...row.snapshot, requestedLimit: 20, items: row.snapshot.items.slice(0, 20).map(item => ({
        id: item.id, position: item.position, title: item.title, url: item.url, author: item.author,
        ...(filmBoardCatalog.find(board => board.id === row.id)?.region === "overseas" ? { sourceSummary: item.sourceSummary ?? (item as unknown as { description?: string }).description ?? null } : {}),
        metrics: heatMetrics(item.metrics),
      })) } : null;
      await tx`UPDATE studio_film_boards SET definition = ${tx.json({ enabled: row.definition.enabled, limit: 20 })}, snapshot = ${snapshot ? tx.json(snapshot as never) : null},
        version = version + 1, run_token = NULL, display_policy_version = 1, state = CASE WHEN state IN ('queued', 'running') THEN 'pending' ELSE state END WHERE id = ${row.id}`;
    }
  });
}
