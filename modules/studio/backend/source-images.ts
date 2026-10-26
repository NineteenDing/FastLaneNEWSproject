import sharp from "sharp";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { Conflict, audit } from "@aihot/backend/audit";
import { sha256 } from "@aihot/backend/lib/ids";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue, QueueDeferred, shutdownSignal } from "@aihot/backend/jobs/queue";
import { createCollectionAdmission } from "./collection-admission.ts";
import { createImageAssets } from "./image-assets.ts";
import type { SourceImage, SourceImages } from "../contracts.ts";

type Candidate = { url: string; description: string };
type Source = { id: string; revision: number; url: string; media: Array<{ kind?: string; url?: string; alt?: string }> };
type Saved = { version_key: string; revision: number; article_url: string; candidates: Candidate[]; images: SourceImage[]; state: string; job_id: string | null; error: string | null; updated_at: Date };
type Job = { articleId: string; versionKey: string };
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
const enabled = collectionEnabled;
const materialId = z.string().regex(/^news:[A-Za-z0-9_-]{1,150}$/);

function candidates(source: Source): Candidate[] {
  const urls = new Set<string>();
  return source.media.filter(item => item.kind === "image" && typeof item.url === "string").slice(0, 12).flatMap(item => {
    try {
      const url = new URL(item.url!);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 8000 || urls.has(url.href)) return [];
      urls.add(url.href); return [{ url: url.href, description: typeof item.alt === "string" ? item.alt.slice(0, 500) : "" }];
    } catch { return []; }
  });
}
function identity(source: Source) {
  const selected = candidates(source);
  return { selected, key: sha256(JSON.stringify({ revision: source.revision, url: source.url, candidates: selected })) };
}
async function source(db: Db, id: string, lock = false) {
  return (await db<Source[]>`SELECT id, revision, url, media FROM articles WHERE id = ${id} ${lock ? db`FOR UPDATE` : db``}`)[0];
}

/** Only a durable intent in the article's own ingestion transaction. Never network/queue setup. */
export async function requestSourceImages(db: Db, articleId: string) {
  const article = await source(db, articleId); if (!article) return;
  const { selected, key } = identity(article);
  await db`INSERT INTO studio_news_image_sets (article_id, version_key, revision, article_url, candidates, state)
    VALUES (${articleId}, ${key}, ${article.revision}, ${article.url}, ${db.json(selected)}, ${selected.length ? 'pending' : 'ready'}) ON CONFLICT DO NOTHING`;
}
async function saved(db: Db, id: string, key: string) {
  return (await db<Saved[]>`SELECT * FROM studio_news_image_sets WHERE article_id = ${id} AND version_key = ${key}`)[0];
}
export async function sourceImages(input: string, db: Db = sql): Promise<SourceImages | null> {
  const id = materialId.parse(input).slice(5), article = await source(db, id); if (!article) return null;
  const { selected, key } = identity(article), row = await saved(db, id, key);
  const [job] = row?.job_id ? await db`SELECT state FROM pgboss.job WHERE name = ${sourceImagesQueue.name} AND id = ${row.job_id}` : [];
  const state = !selected.length ? "empty" : !row ? "not_requested" : row.state === "ready" ? "ready"
    : row.state === "pending" ? "pending" : ['created', 'retry'].includes(job?.state) ? "queued" : job?.state === "active" ? "running" : "failed";
  return { versionKey: key, revision: article.revision, state, enabled: enabled(), candidateCount: selected.length,
    images: row?.images ?? [], error: state === "failed" ? row?.error ?? "图片任务已中断，可显式重试" : null,
    updatedAt: row?.updated_at.toISOString() ?? null };
}
async function enqueue(db: Db, articleId: string, row: Saved) {
  const jobId = await enqueueOn(sourceImagesQueue, { articleId, versionKey: row.version_key },
    { singletonKey: `${articleId}:${row.version_key}`, group: { id: "source-images" } }, db);
  if (jobId) await db`UPDATE studio_news_image_sets SET job_id = ${jobId}, state = 'queued', error = NULL, updated_at = now()
    WHERE article_id = ${articleId} AND version_key = ${row.version_key}`;
  return { queued: !!jobId };
}
export async function submitSourceImages(input: string, value: unknown, actor: string) {
  const id = materialId.parse(input).slice(5), { versionKey } = z.object({ versionKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value);
  if (!enabled()) throw new Conflict("采集开关尚未启用，未提交图片下载");
  await ensureQueue(sourceImagesQueue.name, sourceImagesQueue.options);
  return sql.begin(async db => {
    const article = await source(db, id, true); if (!article) return null;
    if (identity(article).key !== versionKey) throw new Conflict("新闻版本已更新，请刷新情报后再处理配图");
    await requestSourceImages(db, id);
    const row = (await saved(db, id, versionKey))!;
    if (row.state === "ready") return { queued: false };
    const [active] = row.job_id ? await db`SELECT id FROM pgboss.job WHERE id = ${row.job_id} AND name = ${sourceImagesQueue.name} AND state IN ('created', 'retry', 'active')` : [];
    if (active) return { queued: false };
    const result = await enqueue(db, id, row);
    await audit(actor, "studio.source-images.submit", input, null, null, result, { db }); return result;
  });
}

export function createSourceImagesQueue(resources: Pick<NonNullable<Parameters<typeof createCollectionAdmission>[0]>, "host" | "disk" | "database"> = {}) {
return defineQueue<Job>({
  name: "studio.news.images", executionGroup: "studio-creator-media",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission({ ...resources, heavy: true, enabled }),
  async run(jobs) {
    for (const job of jobs) {
      if (!enabled()) throw new QueueDeferred("采集已暂停");
      const row = await saved(sql, job.articleId, job.versionKey); if (!row || row.state === "ready") continue;
      try {
        for (const candidate of row.candidates) {
          if (row.images.some(image => image.sourceUrl === candidate.url)) continue;
          const current = await source(sql, job.articleId);
          if (!current || identity(current).key !== job.versionKey) break;
          if (!enabled()) throw new QueueDeferred("采集已暂停");
          const response = await guardedFetch(candidate.url, { timeoutMs: 10000, maxBytes: 5 * 1024 ** 2, signal: shutdownSignal.signal });
          if (response.status !== 200) throw new Error("图片来源暂不可用");
          const decoder = sharp(response.body, { limitInputPixels: 20_000_000, failOn: "error" }), metadata = await decoder.metadata();
          if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("仅支持静态位图");
          if (!enabled()) throw new QueueDeferred("采集已暂停");
          const normalized = decoder.rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true });
          const jpeg = metadata.format === "jpeg";
          const image = await createImageAssets().put({ body: await (jpeg ? normalized.jpeg({ quality: 90, mozjpeg: true }) : normalized.png({ compressionLevel: 6 })).toBuffer(),
            type: jpeg ? "image/jpeg" : "image/png" });
          await sql.begin(async db => {
            await source(db, job.articleId, true);
            const checkpoint = (await saved(db, job.articleId, job.versionKey))!;
            const images = checkpoint.images.some(item => item.sourceUrl === candidate.url) ? checkpoint.images : [...checkpoint.images,
              { assetId: image.id, url: `/api/admin/studio/image-assets/${image.id}`, sourceUrl: candidate.url, articleUrl: row.article_url,
                revision: row.revision, description: candidate.description, rights: "unknown" as const }];
            await createImageAssets().setReferences(`source-images:${job.articleId}:${job.versionKey}`, images.map(image => image.assetId), db);
            await db`UPDATE studio_news_image_sets SET images = ${db.json(images)}, updated_at = now() WHERE article_id = ${job.articleId} AND version_key = ${job.versionKey}`;
            row.images = images;
          });
        }
        await sql`UPDATE studio_news_image_sets SET state = ${row.images.length === row.candidates.length ? 'ready' : 'failed'}, updated_at = now()
          WHERE article_id = ${job.articleId} AND version_key = ${job.versionKey}`;
      } catch (error) {
        if (error instanceof QueueDeferred) throw error;
        const message = "来源配图未全部保存，请检查来源、图片格式或存储容量后重试；已保存图片仍保留";
        await sql`UPDATE studio_news_image_sets SET state = 'failed', error = ${message}, updated_at = now() WHERE article_id = ${job.articleId} AND version_key = ${job.versionKey}`;
        throw new Error(message);
      }
    }
  },
});
}
export const sourceImagesQueue = createSourceImagesQueue();

export async function scheduleSourceImages() {
  if (!enabled()) return { queued: 0 };
  const pending = await sql`SELECT article_id FROM studio_news_image_sets WHERE state = 'pending' LIMIT 50`;
  if (!pending.length) return { queued: 0 };
  await ensureQueue(sourceImagesQueue.name, sourceImagesQueue.options);
  return sql.begin(async db => {
    const rows = await db<(Saved & { article_id: string })[]>`SELECT i.* FROM studio_news_image_sets i JOIN articles a ON a.id = i.article_id AND a.revision = i.revision
      WHERE i.state = 'pending' ORDER BY i.updated_at, i.article_id FOR UPDATE OF i SKIP LOCKED LIMIT 50`;
    let queued = 0;
    for (const row of rows) if ((await enqueue(db, row.article_id, row)).queued) queued++;
    return { queued };
  });
}
