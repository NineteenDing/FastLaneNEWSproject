import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, ensureQueue, QueueDeferred, shutdownSignal } from "@aihot/backend/jobs/queue";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { readable } from "@aihot/backend/content/extract";
import { contentHash, reviseMaterial, upsertMaterial } from "@aihot/backend/content/materials";
import { createSource } from "@aihot/backend/admin/sources";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { createCollectionAdmission } from "./collection-admission.ts";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";

export const NEWS_REFERENCE_SOURCE_ID = "studio-news-references";
export function assertNewsReferenceNotSubscription(source: { id: string }) {
  if (source.id === NEWS_REFERENCE_SOURCE_ID) throw new UnsupportedConfig("手动新闻原稿用于单篇收纳，不支持启用网站自动采集");
}
type Job = { id: string; token: string };
const fields = sql`id, url, state, CASE WHEN article_id IS NULL THEN NULL ELSE 'news:' || article_id END AS "materialId",
  error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt"`;
const Input = z.object({ url: z.url().max(8000).refine(value => {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, "请填写不带账号密码的HTTP(S)新闻原文链接"), retryFailed: z.boolean().default(false) }).strict();

export async function newsImport(id: string) {
  z.uuid().parse(id);
  const [row] = await sql`SELECT ${fields}, job_id FROM studio_news_imports WHERE id = ${id}`;
  if (!row) return null;
  const { job_id: jobId, ...item } = row;
  if (["queued", "running"].includes(item.state)) {
    const [job] = await sql`SELECT state FROM pgboss.job WHERE name = ${newsImportQueue.name} AND id = ${jobId}`;
    item.state = job?.state === "active" ? "running" : ["created", "retry"].includes(job?.state) ? "queued" : "failed";
    if (item.state === "failed") item.errorCode = "job_interrupted";
  }
  return item;
}

/** Explicit URL submission only. Merely reading references never starts collection. */
export async function submitNewsImport(input: unknown, actor: string) {
  const value = Input.parse(input), identity = identityKeyForUrl(value.url)!;
  await ensureQueue(newsImportQueue.name, newsImportQueue.options);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'studio-news-import:' + identity}, 0))`;
    const [old] = await tx`SELECT ${fields}, job_id FROM studio_news_imports WHERE identity_key = ${identity} FOR UPDATE`;
    if (old && (old.state === "ready" || !value.retryFailed)) {
      const { job_id: _job, ...item } = old; return { queued: false, item };
    }
    const [known] = await tx`SELECT id FROM articles WHERE identity_key = ${identity} AND body_status = 'ok' AND length(trim(body_text)) > 0`;
    const id = old?.id ?? randomUUID(), token = randomUUID();
    if (known) {
      const [item] = await tx`INSERT INTO studio_news_imports (id, identity_key, url, state, article_id, run_token)
        VALUES (${id}, ${identity}, ${value.url}, 'ready', ${known.id}, ${token})
        ON CONFLICT (identity_key) DO UPDATE SET state = 'ready', article_id = EXCLUDED.article_id, run_token = EXCLUDED.run_token, error_code = NULL, updated_at = now()
        RETURNING ${fields}`;
      return { queued: false, item };
    }
    if (!collectionEnabled()) throw new Conflict("采集尚未启用，未提交新闻网页读取");
    if (old?.job_id) {
      const [active] = await tx`SELECT id FROM pgboss.job WHERE name = ${newsImportQueue.name} AND id = ${old.job_id} AND state IN ('created', 'retry', 'active')`;
      if (active) { const { job_id: _job, ...item } = old; return { queued: false, item }; }
    }
    await tx`INSERT INTO studio_news_imports (id, identity_key, url, run_token)
      VALUES (${id}, ${identity}, ${value.url}, ${token}) ON CONFLICT (identity_key) DO UPDATE SET
      state = 'queued', run_token = EXCLUDED.run_token, url = EXCLUDED.url, error_code = NULL, updated_at = now()`;
    const jobId = await enqueueOn(newsImportQueue, { id, token }, { singletonKey: id, group: { id: "news-import" } }, tx);
    if (!jobId) throw new Conflict("新闻原稿仍在处理中，请稍后查看");
    await tx`UPDATE studio_news_imports SET job_id = ${jobId} WHERE id = ${id}`;
    await audit(actor, "studio.news.import", `news-import:${id}`, null, null, { state: "queued" }, { db: tx });
    const [item] = await tx`SELECT ${fields} FROM studio_news_imports WHERE id = ${id}`;
    return { queued: true, item };
  });
}

async function referenceSource(tx: Tx) {
  const [source] = await tx`SELECT kind, enabled, archived, participation_mode FROM sources WHERE id = ${NEWS_REFERENCE_SOURCE_ID} FOR UPDATE`;
  if (source) {
    if (source.kind !== "external" || source.enabled || source.archived || source.participation_mode !== "isolated")
      throw new Conflict("手动新闻原稿存储来源已改变，请检查来源配置");
    return;
  }
  await createSource({ id: NEWS_REFERENCE_SOURCE_ID, name: "手动新闻原稿（不自动订阅）", kind: "external", config: {},
    participation_mode: "isolated", enabled: false }, "system:news-import", tx);
}

export function createNewsImportQueue(resources: Pick<NonNullable<Parameters<typeof createCollectionAdmission>[0]>, "host" | "disk" | "database"> = {}) {
  return defineQueue<Job>({
    name: "studio.news.import", executionGroup: "studio-creator-media",
    options: { policy: "short", retryLimit: 0, expireInSeconds: 120 },
    worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
    admission: createCollectionAdmission({ ...resources, heavy: true }),
    async run(jobs) {
      for (const job of jobs) {
        if (!collectionEnabled()) throw new QueueDeferred("新闻读取已暂停");
        const [claim] = await sql`UPDATE studio_news_imports SET state = 'running', updated_at = now()
          WHERE id = ${job.id} AND run_token = ${job.token} AND state IN ('queued', 'running') RETURNING url`;
        if (!claim) continue;
        try {
          const response = await guardedFetch(claim.url, { timeoutMs: 20_000, maxBytes: 6 * 1024 ** 2, signal: shutdownSignal.signal });
          if (response.status !== 200 || !/html/i.test(response.headers.get("content-type") ?? "")) throw new Error("page_unavailable");
          const html = response.text(), $ = cheerio.load(html);
          const title = ($('meta[property="og:title"]').attr("content") ?? $("title").text() ?? "").trim().slice(0, 1000);
          if (/^(?:安全验证|人机验证|访问验证|滑块验证|请完成验证|Just a moment|Attention required|Verify (?:you|your)|Access denied|Captcha)(?:$|\s|[.!！。…|｜-])/i.test(title))
            throw new Error("verification_required");
          const extracted = readable(html, response.url);
          if (!extracted || !title) throw new Error("body_unavailable");
          await sql.begin(async tx => {
            const [current] = await tx`SELECT id FROM studio_news_imports WHERE id = ${job.id} AND run_token = ${job.token} FOR UPDATE`;
            if (!current) return;
            if (!collectionEnabled() || shutdownSignal.signal.aborted) throw new QueueDeferred("新闻读取已暂停");
            const [known] = await tx`SELECT id, title, excerpt, body_status, body_text FROM articles
              WHERE identity_key = ${identityKeyForUrl(response.url)!} FOR UPDATE`;
            let articleId: string;
            if (known) {
              articleId = known.id;
              if (known.body_status !== "ok" || !known.body_text?.trim()) await reviseMaterial(tx, known.id, {
                set: tx`body_text = ${extracted.text}, body_html = ${extracted.html}, body_status = 'ok', media = ${tx.json(extracted.images)}`,
                title: known.title, bodyText: extracted.text,
                hash: contentHash({ title: known.title, excerpt: known.excerpt, bodyText: extracted.text }),
              });
            } else {
              await referenceSource(tx);
              const stored = await upsertMaterial({ sourceId: NEWS_REFERENCE_SOURCE_ID, url: response.url, title, bodyText: extracted.text,
                bodyHtml: extracted.html, bodyStatus: "ok", media: extracted.images, publishedAt: extracted.publishedAt, via: "studio-news-import" }, tx);
              articleId = stored.articleId;
              if (stored.created) {
                // The original publisher attribution may create a projection in this transaction.
                // Retain an explicit private override even if attribution later changes the source.
                await tx`INSERT INTO editorial_overrides (article_id, visibility, reason, updated_by)
                  VALUES (${stored.articleId}, 'withdrawn', '私有写作参考导入', 'system:news-import') ON CONFLICT DO NOTHING`;
                await publishArticleTx(tx, stored.articleId);
              }
            }
            await tx`UPDATE studio_news_imports SET state = 'ready', article_id = ${articleId}, error_code = NULL, updated_at = now() WHERE id = ${job.id}`;
          });
        } catch (error) {
          if (error instanceof QueueDeferred || !collectionEnabled() || shutdownSignal.signal.aborted) throw new QueueDeferred("新闻读取已暂停");
          await sql`UPDATE studio_news_imports SET state = 'failed', error_code = 'page_unavailable', updated_at = now()
            WHERE id = ${job.id} AND run_token = ${job.token}`;
          throw new Error("新闻原稿未读取完成，请检查链接、网络或页面访问要求后重试");
        }
      }
    },
  });
}
export const newsImportQueue = createNewsImportQueue();
