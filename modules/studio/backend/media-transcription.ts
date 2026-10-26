import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename } from "node:fs/promises";
import { z } from "zod";
import sharp from "sharp";
import { sql } from "@aihot/backend/db";
import { Conflict } from "@aihot/backend/audit";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { createStorageWorkspaces } from "./storage-workspaces.ts";
import { createImageAssets } from "./image-assets.ts";
import { indexHistoryMaterial } from "./history-index.ts";
import { requestMaterialAnalysis } from "./material-analysis-pending.ts";

const maximumMediaBytes = 512 * 1024 ** 2;
const workspaceBytes = maximumMediaBytes + 8 * 1024 ** 2 + 1024;
const segment = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().trim().min(1).max(20000) }).strict()
  .refine(value => value.end > value.start, "转写时间段无效");
const keyframes = z.array(z.object({ timeSeconds: z.number().finite().nonnegative(),
  pngBase64: z.string().min(4).max(1_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).min(1).max(4);
const range = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).strict().refine(value => value.end > value.start);
const rhythm = z.object({ version: z.literal(1), audio: z.object({ method: z.literal("rms_20ms_v1"), timeBasis: z.literal("decoded_audio"), observedSeconds: z.number().finite().positive().max(7200),
  quietThresholdDbfs: z.literal(-40), minimumQuietSeconds: z.literal(0.3), quietSeconds: z.number().finite().nonnegative().max(7200),
  quietIntervalCount: z.number().int().min(0).max(24000), quietIntervals: z.array(range).max(120), truncated: z.boolean(),
  windows: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), rmsDbfs: z.number().finite().min(-120).max(10),
    quietFraction: z.number().finite().min(0).max(1) }).strict()).max(720) }).strict().nullable(),
  visual: z.object({ method: z.literal("sampled_rgb_v1"), timeBasis: z.literal("video_elapsed"), sampleIntervalSeconds: z.literal(0.5), changeThreshold: z.literal(0.18),
    sampleCount: z.number().int().positive().max(14401), sampledUntilSeconds: z.number().finite().nonnegative().max(7200),
    changeCount: z.number().int().nonnegative().max(14400), changeTimes: z.array(z.number().finite().nonnegative().max(7200)).max(120), truncated: z.boolean(),
    windows: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), samples: z.number().int().positive().max(21),
      changes: z.number().int().nonnegative().max(20) }).strict()).max(720) }).strict().nullable() }).strict();
function rhythmWithinDuration(value: { durationSeconds: number; rhythm?: z.infer<typeof rhythm> }) {
  const audio = value.rhythm?.audio, visual = value.rhythm?.visual;
  if (audio) {
    const intervals = audio.quietIntervals, windows = audio.windows;
    if (audio.observedSeconds > value.durationSeconds + 0.1 || audio.quietSeconds > audio.observedSeconds || !windows.length
      || audio.quietIntervalCount < intervals.length || audio.truncated !== (audio.quietIntervalCount > intervals.length)
      || intervals.some((item, index) => item.end > audio.observedSeconds || item.end - item.start < 0.3 - 0.0001 || index > 0 && item.start < intervals[index - 1]!.end)
      || windows[0]!.start !== 0 || Math.abs(windows.at(-1)!.end - audio.observedSeconds) > 0.001
      || windows.some((item, index) => item.end <= item.start || item.end > audio.observedSeconds || index > 0 && Math.abs(item.start - windows[index - 1]!.end) > 0.001)) return false;
    const quiet = intervals.reduce((sum, item) => sum + item.end - item.start, 0);
    if (audio.quietSeconds + 0.001 < quiet || !audio.truncated && Math.abs(audio.quietSeconds - quiet) > 0.001) return false;
  }
  if (visual && (visual.sampledUntilSeconds > value.durationSeconds + 0.1 || visual.changeCount >= visual.sampleCount
    || visual.changeTimes.length > visual.changeCount || visual.truncated !== (visual.changeCount > visual.changeTimes.length)
    || visual.changeTimes.some((time, index) => time > visual.sampledUntilSeconds || index > 0 && time <= visual.changeTimes[index - 1]!)
    || visual.windows.reduce((sum, item) => sum + item.samples, 0) !== visual.sampleCount || visual.windows.reduce((sum, item) => sum + item.changes, 0) !== visual.changeCount
    || visual.windows.some((item, index) => item.start >= item.end || item.end > value.durationSeconds + 0.1 || item.changes > item.samples
      || index > 0 && item.start < visual.windows[index - 1]!.end))) return false;
  return true;
}
const visuals = z.object({ durationSeconds: z.number().finite().positive().max(7200), frames: keyframes, rhythm: rhythm.optional() }).strict().refine(rhythmWithinDuration, "节奏观察与实际媒体时长或覆盖范围不一致");
export type MediaVisuals = z.infer<typeof visuals>;
export const parseMediaVisuals = (input: unknown): MediaVisuals => visuals.parse(input);
const recognition = z.object({ language: z.string().min(1).max(20), durationSeconds: z.number().finite().positive().max(7200), model: z.string().min(1).max(200),
  segments: z.array(segment).min(1).max(20000), frames: keyframes.optional(), rhythm: rhythm.optional() }).strict().refine(value => value.segments.every((item, index) => item.end <= value.durationSeconds + 0.1
    && (!index || item.start >= value.segments[index - 1]!.start)) && value.segments.reduce((sum, item) => sum + item.text.length, 0) <= 200000,
  "转写不完整或超过处理预算").refine(rhythmWithinDuration, "节奏观察与实际媒体时长或覆盖范围不一致");
export type MediaRecognition = z.infer<typeof recognition>;
export const parseMediaRecognition = (input: unknown): MediaRecognition => recognition.parse(input);
type Post = { id: string; platform: string; url: string; externalId: string; fingerprint: string };
type MediaSource = { url: string; backupUrls?: string[]; kind: "audio" | "video"; headers?: Record<string, string>; subtitles?: MediaRecognition };

/** Adapted from fixed MediaCrawler media_downloader/downloader.py; see vendor NOTICE.
 * Keep primary/backup ordering with one deadline and byte budget, never join fragments. */
async function downloadMedia(media: MediaSource, signal: AbortSignal): Promise<Buffer> {
  const candidates = z.array(z.url().max(8000)).min(1).max(3).parse([...new Set([media.url, ...(media.backupUrls ?? [])])]);
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  let remainingBytes = maximumMediaBytes;
  for (const candidate of candidates) {
    const response = await guardedFetch(candidate, { headers: media.headers, timeoutMs: 120000, maxBytes: remainingBytes, signal: downloadSignal });
    remainingBytes -= response.body.length;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const playlist = /mpegurl|m3u8/.test(contentType ?? "") || response.body.subarray(0, 1024).toString("utf8").trimStart().startsWith("#EXTM3U");
    // Absent/neutral headers remain usable, while HTML/JSON/text/HLS cannot
    // become ASR checkpoints. The actual recognizer still validates the media.
    const mediaType = !playlist && (!contentType || ["application/octet-stream", "binary/octet-stream", "application/mp4", "application/x-m4a"].includes(contentType)
      || contentType.startsWith("video/") || contentType.startsWith("audio/"));
    if (response.status === 200 && response.body.length && mediaType) return response.body;
    // Expired/inaccessible media can use a backup. Rate limits and other
    // errors go back to the durable retry policy instead of multiplying calls.
    if (![200, 206, 403, 404, 410].includes(response.status) || remainingBytes <= 0) break;
  }
  throw new Conflict("视频下载未完成，未开始转写");
}

/** External platform resolution and local speech recognition are adapters; persistence and file lifecycle stay here. */
export function createMediaTranscriptionProcessor(adapters: {
  resolve(post: Post, options: { signal: AbortSignal }): Promise<MediaSource>;
  recognize(input: { file: string; signal: AbortSignal }): Promise<MediaRecognition>;
  frames?(input: { file: string; signal: AbortSignal }): Promise<MediaVisuals>;
}) {
  const workspaces = createStorageWorkspaces();
  async function cleanup(postId: string, workspaceId: string) {
    try {
      await workspaces.cleanup(workspaceId);
      await sql`UPDATE studio_media_transcripts SET workspace_id = NULL WHERE post_id = ${postId} AND workspace_id = ${workspaceId}`;
      return true;
    } catch { return false; } // Saved results remain readable; the durable workspace reference retains cleanup debt.
  }
  return {
    /** Bounded restart/maintenance pass; counts describe this batch, never unsaved or active media. */
    async cleanupPending() {
      const rows = await sql<{ post_id: string; workspace_id: string }[]>`SELECT post_id, workspace_id FROM studio_media_transcripts WHERE workspace_id IS NOT NULL ORDER BY saved_at, post_id LIMIT 30`;
      let cleaned = 0;
      for (const row of rows) if (await cleanup(row.post_id, row.workspace_id)) cleaned++;
      return { cleaned, pending: rows.length - cleaned };
    },
    /** Six-hour failed/orphan retention. The claim lock prevents a retry taking a selected directory. */
    async cleanupExpired() {
      const now = new Date(), before = new Date(now.getTime() - 6 * 3600_000);
      return sql.begin(async db => {
        await db`SELECT pg_advisory_xact_lock(hashtext('studio-media-processing'))`;
        const rows = await db<{ id: string }[]>`SELECT w.id FROM studio_storage_workspaces w
          LEFT JOIN studio_media_processing_lease active ON active.task = w.task AND active.expires_at > ${now}
          LEFT JOIN studio_media_transcripts saved ON saved.workspace_id = w.id
          WHERE w.category = 'media' AND w.task LIKE 'transcribe:%' AND w.created_at <= ${before}
            AND active.id IS NULL AND saved.post_id IS NULL ORDER BY w.created_at, w.id LIMIT 30`;
        let cleaned = 0;
        for (const row of rows) {
          try { await workspaces.cleanup(row.id); cleaned++; } catch { /* Retry denied or occupied files on the next pass; reservation remains. */ }
        }
        return { cleaned, pending: rows.length - cleaned };
      });
    },
    async process(input: string, options: { signal?: AbortSignal } = {}) {
      const id = z.uuid().parse(input);
      const [post] = await sql<Post[]>`SELECT p.id, c.platform, p.content->>'url' AS url, p.external_id AS "externalId", p.content_fingerprint AS fingerprint
        FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id WHERE p.id = ${id} AND p.content->>'kind' = 'video'`;
      // Original B站 records predate explicit kind; those retain the documented video default.
      const [legacy] = post ? [] : await sql<Post[]>`SELECT p.id, c.platform, p.content->>'url' AS url, p.external_id AS "externalId", p.content_fingerprint AS fingerprint
        FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id WHERE p.id = ${id} AND p.content->>'kind' IS NULL`;
      const current = post ?? legacy;
      if (!current) throw new Conflict("没有可转写的视频材料");
      const [saved] = await sql`SELECT result, workspace_id FROM studio_media_transcripts WHERE post_id = ${id} AND source_fingerprint = ${current.fingerprint}`;
      if (saved) {
        if (saved.workspace_id) await cleanup(id, saved.workspace_id);
        return { state: "ready" as const };
      }
      const task = `transcribe:${id}:${current.fingerprint}`, token = randomUUID();
      const signal = AbortSignal.any([AbortSignal.timeout(90 * 60_000), ...(options.signal ? [options.signal] : [])]);
      const claimedAt = new Date(), expiresAt = new Date(claimedAt.getTime() + 2 * 3600_000);
      await sql.begin(async db => {
        await db`SELECT pg_advisory_xact_lock(hashtext('studio-media-processing'))`;
        if ((await db`SELECT id FROM studio_media_processing_lease WHERE expires_at > ${claimedAt}`).length) throw new Conflict("已有视频正在转写，请等待当前任务完成");
        await db`INSERT INTO studio_media_processing_lease (id, token, task, expires_at) VALUES (1, ${token}, ${task}, ${expiresAt})
          ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, task = EXCLUDED.task, expires_at = EXCLUDED.expires_at`;
      });
      try {
      signal.throwIfAborted();
      // The JSON result must fit beside the media until the database commit succeeds.
      let workspace = await workspaces.reserve({ task, category: "media", bytes: workspaceBytes });
      let file = path.join(workspace.directory, "source.media");
      const ready = path.join(workspace.directory, "download.ready");
      const marker = await lstat(ready).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      let mediaKind: "audio" | "video", subtitles: MediaRecognition | undefined;
      if (marker) {
        if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 1024) throw new Conflict("下载完成记录不安全，原媒体与已有结果已保留");
        const completed = z.object({ version: z.literal(1), kind: z.enum(["audio", "video"]), hasSubtitles: z.boolean().default(false) }).strict().parse(JSON.parse(await readFile(ready, "utf8")));
        mediaKind = completed.kind;
        if (completed.hasSubtitles) {
          const captionFile = path.join(workspace.directory, "subtitles.json"), info = await lstat(captionFile);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 ** 2) throw new Conflict("平台字幕记录不完整或不安全，原媒体已保留");
          subtitles = recognition.parse(JSON.parse(await readFile(captionFile, "utf8")));
        }
      } else {
        // No published marker means a crash may have left an unverified/partial file.
        // Reconcile only this leased, managed workspace; never try wx over a leftover.
        if (await lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
          await workspaces.cleanup(workspace.id);
          workspace = await workspaces.reserve({ task, category: "media", bytes: workspaceBytes });
          file = path.join(workspace.directory, "source.media");
        }
        let media: MediaSource, downloaded: Buffer;
        try {
          media = await adapters.resolve(current, { signal });
          downloaded = await downloadMedia(media, signal);
        } catch (error) {
          // Nothing was downloaded or recognized in this fresh directory. Failed cleanup
          // retains its reservation and remains eligible for the existing expiry pass.
          await workspaces.cleanup(workspace.id).catch(() => {}); throw error;
        }
        mediaKind = media.kind;
        await workspaces.write(workspace.id, "source.media", (async function* () { yield downloaded; })());
        if (media.subtitles) {
          const { frames: _unobservedFrames, rhythm: _unobservedRhythm, ...caption } = recognition.parse(media.subtitles);
          const encoded = Buffer.from(JSON.stringify(caption));
          if (encoded.length > 1024 ** 2) throw new Conflict("平台字幕超过单条输入预算，原媒体已保留");
          await workspaces.write(workspace.id, "subtitles.json", (async function* () { yield encoded; })());
          subtitles = caption;
        }
        // Publish the synced type separately from the expiring URL. A restart with a
        // complete download/checkpoint can finish without platform access or credentials.
        await workspaces.write(workspace.id, "download.part", (async function* () { yield Buffer.from(JSON.stringify({ version: 1, kind: mediaKind, hasSubtitles: !!subtitles })); })());
        await rename(path.join(workspace.directory, "download.part"), path.join(workspace.directory, "download.ready"));
      }
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > maximumMediaBytes) throw new Conflict("下载媒体不完整，请重新处理");
      let result: MediaRecognition;
      if (subtitles) {
        if (mediaKind === "video") {
          if (!adapters.frames) throw new Conflict("已取得字幕，必要关键帧读取尚未接通，未启动ASR或清理媒体");
          const observed = visuals.parse(await adapters.frames({ file, signal }));
          if (Math.abs(observed.durationSeconds - subtitles.durationSeconds) > 2) throw new Conflict("字幕与实际媒体时长不一致，请核对原作品，未清理媒体");
          result = recognition.parse({ ...subtitles, frames: observed.frames, rhythm: observed.rhythm });
        } else result = subtitles;
      } else result = recognition.parse(await adapters.recognize({ file, signal }));
      signal.throwIfAborted();
      if (mediaKind === "video" && !result.frames?.length) throw new Conflict("必要关键帧尚未取得，原视频保留供继续处理；未标记为成功");
      const assets = createImageAssets(), frames: Array<{ timeSeconds: number; assetId: string; url: string }> = [];
      for (const frame of result.frames ?? []) {
        const bytes = Buffer.from(frame.pngBase64, "base64");
        if (frame.timeSeconds > result.durationSeconds + 0.1 || bytes.toString("base64") !== frame.pngBase64) throw new Conflict("关键帧时间或图片不完整，原媒体已保留");
        const decoder = sharp(bytes, { limitInputPixels: 640 * 640, failOn: "error" }), metadata = await decoder.metadata();
        if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1) throw new Conflict("关键帧必须是实际静态PNG图片");
        const image = await assets.put({ body: await decoder.resize({ width: 640, height: 360, fit: "inside", withoutEnlargement: true }).png().toBuffer(), type: "image/png" });
        frames.push({ timeSeconds: frame.timeSeconds, assetId: image.id, url: `/api/admin/studio/image-assets/${image.id}` });
      }
      const { frames: _encodedFrames, ...speech } = result;
      const transcript = { ...speech, frames, text: result.segments.map(item => item.text).join("\n"), method: subtitles ? "platform_subtitle" : "local_asr", visualEvidence: frames.length ? "keyframes_saved" : "not_observed" };
      await sql.begin(async db => {
        const [latest] = await db`SELECT content_fingerprint FROM studio_creator_posts WHERE id = ${id} FOR UPDATE`;
        if (latest?.content_fingerprint !== current.fingerprint) throw new Conflict("视频资料已更新，转写未覆盖新版本，请重新处理");
        // Version-specific owners preserve evidence already captured by a frozen batch or draft.
        await assets.setReferences(`media:${id}:${current.fingerprint}`, frames.map(frame => frame.assetId), db);
        await db`INSERT INTO studio_media_transcripts (post_id, source_fingerprint, result, workspace_id)
          VALUES (${id}, ${current.fingerprint}, ${db.json(transcript)}, ${workspace.id})
          ON CONFLICT (post_id) DO UPDATE SET source_fingerprint = EXCLUDED.source_fingerprint, result = EXCLUDED.result, workspace_id = EXCLUDED.workspace_id, saved_at = now()`;
        await indexHistoryMaterial(db, "creator:" + id);
        await requestMaterialAnalysis(db, "creator:" + id);
      });
      return { state: "ready" as const, mediaCleaned: await cleanup(id, workspace.id) };
      } finally {
        await sql`DELETE FROM studio_media_processing_lease WHERE id = 1 AND token = ${token}`;
      }
    },
  };
}
