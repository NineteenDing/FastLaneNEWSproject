import {creatorMediaRelevant} from "./creator-intake.ts";
import {mediaControlState} from "./media-control.ts";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { Conflict, audit } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue, shutdownSignal, QueueDeferred } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "./collection-admission.ts";
import { createPlatformMediaProcessor } from "./platform-media.ts";
import { createHostResourceMonitor } from "./host-resources.ts";
import { createDiskResourceMonitor } from "./disk-resources.ts";
import { createDatabaseResourceMonitor } from "./database-resources.ts";
import type { MediaProcessingStatus } from "../contracts.ts";

import { collectionEnabled } from "@aihot/backend/operations/collection-control";
export const mediaProcessingEnabled = () => collectionEnabled() && mediaControlState().enabled;
type Job = { postId: string; fingerprint: string };

/** One immediate download/recognition/cleanup at a time; no predownload queue. */
export function createMediaProcessingQueue(options: Parameters<typeof createPlatformMediaProcessor>[0] = {},
  host = createHostResourceMonitor(), disk = createDiskResourceMonitor(), database = createDatabaseResourceMonitor()) {
  const processor = createPlatformMediaProcessor(options);
  return defineQueue<Job>({ name: "studio.media.process",
    executionGroup: "studio-creator-media",
    options: { policy: "short", retryLimit: 1, retryDelay: 60, expireInSeconds: 7200 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
    admission: createCollectionAdmission({ host, disk, database, heavy: true, enabled: mediaProcessingEnabled }),
    async run(jobs) {
      for (const job of jobs) {
        if (!mediaProcessingEnabled()) throw new QueueDeferred("采集或本地媒体处理已暂停");
        const [metadata] = await sql`SELECT content FROM studio_creator_posts WHERE id=${job.postId}`;
        if(!metadata || !creatorMediaRelevant(metadata.content)) { await sql`UPDATE studio_media_jobs SET state='failed',error='标题与简介未通过AI相关性预筛，未下载',updated_at=now() WHERE post_id=${job.postId}`; continue; }
        const [claimed] = await sql`UPDATE studio_media_jobs j SET state = 'running', error = NULL, updated_at = now()
          FROM studio_creator_posts p WHERE j.post_id = ${job.postId} AND j.source_fingerprint = ${job.fingerprint}
            AND p.id = j.post_id AND p.content_fingerprint = j.source_fingerprint AND j.state <> 'ready' RETURNING j.post_id`;
        if (!claimed) continue;
        try {
          await processor.process(job.postId, { signal: shutdownSignal.signal });
          await sql`UPDATE studio_media_jobs SET state = 'ready', error = NULL, updated_at = now()
            WHERE post_id = ${job.postId} AND source_fingerprint = ${job.fingerprint}`;
        } catch {
          const error = "视频处理未完成，已保留可恢复结果；请检查平台状态、媒体格式和本地转写组件";
          await sql`UPDATE studio_media_jobs SET state = 'failed', error = ${error}, updated_at = now()
            WHERE post_id = ${job.postId} AND source_fingerprint = ${job.fingerprint}`;
          throw new Error(error);
        }
      }
    },
  });
}
export const mediaProcessingQueue = createMediaProcessingQueue();

/** May join collection's transaction so a committed video always has its durable processing task. */
export async function enqueueMediaProcessing(postId: string, actor: string, options: { db?: Tx; retryFailed?: boolean } = {}) {
  z.uuid().parse(postId);
  if (!mediaProcessingEnabled()) throw new Conflict("本地媒体处理尚未启用，未提交下载或转写任务");
  await ensureQueue(mediaProcessingQueue.name, mediaProcessingQueue.options);
  const submit = async (db: Tx) => {
    await db`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
    const [post] = await db`SELECT p.content_fingerprint AS fingerprint, p.content->>'kind' AS kind, p.content, c.platform
      FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id WHERE p.id = ${postId} FOR UPDATE OF p`;
    if (!post) return null;
    if(!creatorMediaRelevant(post.content)) throw new Conflict("标题与简介未通过AI相关性预筛，未提交下载或转写");
    if (post.kind !== "video" && !(post.kind === null && post.platform === "bilibili")) throw new Conflict("这条材料不是需要转写的视频");
    if (!['bilibili', 'weibo', 'xhs', 'douyin', 'kuaishou'].includes(post.platform)) throw new Conflict("此平台的媒体适配尚未接通");
    const [saved] = await db`SELECT post_id FROM studio_media_transcripts WHERE post_id = ${postId} AND source_fingerprint = ${post.fingerprint}`;
    if (saved) return { queued: false, state: "ready" as const };
    const [previous] = await db`SELECT j.state FROM studio_media_jobs m LEFT JOIN pgboss.job j ON j.name = ${mediaProcessingQueue.name} AND j.id = m.job_id
      WHERE m.post_id = ${postId} AND m.source_fingerprint = ${post.fingerprint}`;
    if (previous && (!options.retryFailed || previous.state && !['failed', 'cancelled', 'completed'].includes(previous.state))) return { queued: false };
    const id = await enqueueOn(mediaProcessingQueue, { postId, fingerprint: post.fingerprint },
      { singletonKey: `${postId}:${post.fingerprint}`, group: { id: "studio-media" } }, db);
    if (!id) return { queued: false };
    await db`INSERT INTO studio_media_jobs (post_id, source_fingerprint, job_id, state) VALUES (${postId}, ${post.fingerprint}, ${id}, 'queued')
      ON CONFLICT (post_id) DO UPDATE SET source_fingerprint = EXCLUDED.source_fingerprint, job_id = EXCLUDED.job_id, state = 'queued', error = NULL, updated_at = now()`;
    await audit(actor, "studio.media.submit", `creator-post:${postId}`, null, null, { queued: true }, { db });
    return { queued: true };
  };
  return options.db ? submit(options.db) : sql.begin(submit);
}

export async function mediaProcessingStatus(postId: string): Promise<MediaProcessingStatus | null> {
  z.uuid().parse(postId);
  const [row] = await sql`SELECT p.id, p.content_fingerprint AS fingerprint, m.source_fingerprint AS job_fingerprint,
    m.state, m.error, m.updated_at, m.job_id,
    t.source_fingerprint AS transcript_fingerprint FROM studio_creator_posts p
    LEFT JOIN studio_media_jobs m ON m.post_id = p.id
    LEFT JOIN studio_media_transcripts t ON t.post_id = p.id WHERE p.id = ${postId}`;
  if (!row) return null;
  const current = row.job_fingerprint === row.fingerprint;
  const [job] = current ? await sql`SELECT state FROM pgboss.job WHERE name = ${mediaProcessingQueue.name} AND id = ${row.job_id}` : [];
  const state = row.transcript_fingerprint === row.fingerprint ? "ready" : !current ? "not_queued"
    : ['created', 'retry'].includes(job?.state) ? "queued" : job?.state === "active" ? "running" : "failed";
  return { state, enabled: mediaProcessingEnabled(), error: state === "failed" ? row.error ?? "处理任务已中断，可重新提交" : null,
    updatedAt: current ? row.updated_at.toISOString() : null };
}

/** Runs without downloads/model work even when collection is paused. Active leases stay protected. */
export async function maintainMediaWorkspaces() {
  const processor = createPlatformMediaProcessor();
  return { saved: await processor.cleanupPending(), expired: await processor.cleanupExpired() };
}
