import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { trendContextAllowed, type TrendContext } from "./trend-context.ts";
import { createCollectionAdmission } from "./collection-admission.ts";
import { creatorsCollecting } from "./creator-collection.ts";
import { collectMediaCreator, MediaCrawlerFailure, RepresentativeUnavailable } from "./mediacrawler.ts";
import { platformSessionSecret, platformSessionUnchanged } from "./platform-sessions.ts";
import { saveCreatorContent } from "./creator-content.ts";
import { creatorLink } from "./creator-links.ts";
import { bindCreatorIdentity, lockCreatorIdentity } from "./creator-identity.ts";
import type { CreatorPlatform } from "../contracts.ts";

export function contentLink(value: unknown) {
  const address = new URL(z.url().max(8000).parse(value));
  const answer = /^\/question\/(\d{1,20})\/answer\/(\d{1,20})\/?$/.exec(address.pathname);
  if (address.protocol === "https:" && !address.username && !address.password && !address.port && address.hostname.replace(/^www\./, "") === "zhihu.com" && answer)
    return { platform: "zhihu" as const, externalId: "answer:" + answer[2], url: `https://www.zhihu.com/question/${answer[1]}/answer/${answer[2]}`, context: { questionId: answer[1]! } as Record<string, string> };
  const rules: { platform: CreatorPlatform; host: string; pattern: RegExp; prefix: string }[] = [
    { platform: "bilibili", host: "bilibili.com", pattern: /^\/video\/(BV[A-Za-z0-9]{6,20})\/?$/, prefix: "https://www.bilibili.com/video/" },
    { platform: "weibo", host: "m.weibo.cn", pattern: /^\/detail\/(\d{1,20})\/?$/, prefix: "https://m.weibo.cn/detail/" },
    { platform: "weibo", host: "weibo.com", pattern: /^\/\d{1,20}\/(\d{1,20})\/?$/, prefix: "https://m.weibo.cn/detail/" },
    { platform: "xhs", host: "xiaohongshu.com", pattern: /^\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})\/?$/, prefix: "https://www.xiaohongshu.com/explore/" },
    { platform: "douyin", host: "douyin.com", pattern: /^\/video\/(\d{1,20})\/?$/, prefix: "https://www.douyin.com/video/" },
    { platform: "kuaishou", host: "kuaishou.com", pattern: /^\/short-video\/([A-Za-z0-9_-]{1,100})\/?$/, prefix: "https://www.kuaishou.com/short-video/" },
    { platform: "zhihu", host: "zhuanlan.zhihu.com", pattern: /^\/p\/(\d{1,20})\/?$/, prefix: "https://zhuanlan.zhihu.com/p/" },
    { platform: "tieba", host: "tieba.baidu.com", pattern: /^\/p\/(\d{1,20})\/?$/, prefix: "https://tieba.baidu.com/p/" },
  ];
  if (address.protocol === "https:" && !address.username && !address.password && !address.port) for (const rule of rules) {
    const id = address.hostname.replace(/^www\./, "") === rule.host && rule.pattern.exec(address.pathname)?.[1];
    if (!id) continue;
    const context: Record<string, string> = {};
    if (rule.platform === "xhs") {
      context.xsec_token = z.string().min(1).max(2000).parse(address.searchParams.get("xsec_token"));
      context.xsec_source = z.string().max(200).parse(address.searchParams.get("xsec_source") || "pc_feed");
    }
    return { platform: rule.platform, externalId: rule.platform === "zhihu" ? "article:" + id : id, url: rule.prefix + id, context };
  }
  throw new z.ZodError([{ code: "custom", path: ["url"], message: "请填写七平台的完整作品链接（知乎为具体回答或文章、贴吧为帖子）；小红书需保留分享参数" }]);
}
function authorHome(platform: string, locator: string) {
  const prefix: Record<string, string> = { bilibili: "https://space.bilibili.com/", weibo: "https://weibo.com/u/", xhs: "https://www.xiaohongshu.com/user/profile/",
    douyin: "https://www.douyin.com/user/", kuaishou: "https://www.kuaishou.com/profile/", zhihu: "https://www.zhihu.com/people/", tieba: "https://tieba.baidu.com/home/main?id=" };
  return creatorLink((prefix[platform] ?? "") + locator).homepage;
}
const publicFields = sql`id, platform, url, state, CASE WHEN post_id IS NULL THEN NULL ELSE 'creator:' || post_id END AS "materialId",
  error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt",
  CASE WHEN external_id LIKE 'trend:%' THEN 'trend_deep_read' ELSE 'single_content' END AS "retryVia"`;
export async function contentImports() {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const pending = await tx`SELECT ${publicFields}, job_id FROM studio_content_imports ORDER BY created_at DESC, id LIMIT 100`;
    const [schema] = await tx`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`;
    const jobs = schema!.present && pending.length ? await tx`SELECT id, state FROM pgboss.job
      WHERE name = ${contentImportQueue.name} AND id = ANY(${pending.map(row => row.job_id).filter(Boolean)}::uuid[])` : [];
    return { rows: pending.map(row => {
      const { job_id: jobId, ...item } = row;
      const job = jobs.find(job => job.id === jobId);
      if (["queued", "running"].includes(item.state)) {
        if (!job || ["completed", "failed", "cancelled"].includes(job.state)) { item.state = "failed"; item.errorCode = "job_interrupted"; }
        else item.state = job.state === "active" ? "running" : "queued";
      }
      return item;
    }), limit: 100 };
  });
}
/** Exact durable-task lookup, independent of the recent-100 list used by the general import panel. */
export async function contentImport(id: string) {
  z.uuid().parse(id);
  const [row] = await sql`SELECT ${publicFields}, job_id FROM studio_content_imports WHERE id = ${id}`;
  if (!row) return null;
  const { job_id: jobId, ...item } = row;
  if (["queued", "running"].includes(item.state)) {
    const [job] = await sql`SELECT state FROM pgboss.job WHERE name = ${contentImportQueue.name} AND id = ${jobId}`;
    item.state = job?.state === "active" ? "running" : ["created", "retry"].includes(job?.state) ? "queued" : "failed";
    if (item.state === "failed") item.errorCode = "job_interrupted";
  }
  return item;
}
export async function submitContentImport(input: unknown, actor: string, control: { db?: Tx; priority?: number; trend?: TrendContext; representative?: { platform: "weibo" | "douyin" | "kuaishou" | "zhihu" | "tieba"; keyword: string } } = {}) {
  const options = z.object({ url: z.string(), retryFailed: z.boolean().default(false) }).strict().parse(input);
  if (control.representative && !control.trend) throw new Error("代表内容必须关联有效热榜上下文");
  const searchTerm = control.representative ? z.string().trim().min(1).max(500).parse(control.representative.keyword) : undefined;
  const link = control.representative ? { platform: control.representative.platform, externalId: `trend:${control.trend!.signalId}:${control.trend!.key}`, url: options.url, context: {} } : contentLink(options.url);
  const work = async (tx: Tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'studio-content-import:' + link.platform + ':' + link.externalId}, 0))`;
    const [old] = await tx`SELECT ${publicFields}, job_id FROM studio_content_imports WHERE platform = ${link.platform} AND external_id = ${link.externalId} FOR UPDATE`;
    if (old && (old.state === "ready" || !options.retryFailed)) { const { job_id: _job, ...item } = old; return { queued: false, item }; }
    const [known] = await tx`SELECT p.id FROM studio_creator_posts p JOIN studio_creator_accounts c ON c.id = p.creator_id
      WHERE c.platform = ${link.platform} AND p.external_id = ${link.externalId} LIMIT 1`;
    if (known) {
      const [item] = await tx`INSERT INTO studio_content_imports (id, platform, external_id, url, context, run_token, state, post_id)
        VALUES (${old?.id ?? randomUUID()}, ${link.platform}, ${link.externalId}, ${link.url}, ${tx.json(link.context)}, ${randomUUID()}, 'ready', ${known.id})
        ON CONFLICT (platform, external_id) DO UPDATE SET state = 'ready', post_id = EXCLUDED.post_id, error_code = NULL, updated_at = now() RETURNING ${publicFields}`;
      return { queued: false, item };
    }
    if (!creatorsCollecting()) throw new Conflict("采集开关尚未启用");
    if (old?.job_id) {
      const [active] = await tx`SELECT id FROM pgboss.job WHERE name = ${contentImportQueue.name} AND id = ${old.job_id} AND state IN ('created', 'retry', 'active')`;
      if (active) throw new Conflict("这个作品仍在等待或处理中");
    }
    const id = old?.id ?? randomUUID(), token = randomUUID();
    await tx`INSERT INTO studio_content_imports (id, platform, external_id, url, context, run_token)
      VALUES (${id}, ${link.platform}, ${link.externalId}, ${link.url}, ${tx.json(link.context)}, ${token})
      ON CONFLICT (platform, external_id) DO UPDATE SET state = 'queued', run_token = EXCLUDED.run_token, context = EXCLUDED.context, error_code = NULL, updated_at = now()`;
    const jobId = await enqueueOn(contentImportQueue, { id, token, ...(control.trend ? { trend: control.trend } : {}), ...(searchTerm ? { searchTerm } : {}) }, { singletonKey: id, group: { id: "creator-media" }, priority: control.priority ?? 0 }, tx);
    if (!jobId) throw new Conflict("作品导入任务仍在处理中");
    await tx`UPDATE studio_content_imports SET job_id = ${jobId} WHERE id = ${id}`;
    await audit(actor, "studio.content.import", `content-import:${id}`, null, null, { platform: link.platform }, { db: tx });
    const [item] = await tx`SELECT ${publicFields} FROM studio_content_imports WHERE id = ${id}`;
    return { queued: true, item };
  };
  return control.db ? work(control.db) : sql.begin(work);
}
export const contentImportQueue = defineQueue<{ id: string; token: string; trend?: TrendContext; searchTerm?: string }>({
  name: "studio.content.import", executionGroup: "studio-creator-media",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: createCollectionAdmission({ heavy: true, enabled: creatorsCollecting }),
  async run(jobs) {
    for (const job of jobs) {
      if (!creatorsCollecting()) continue;
      if (job.trend) {
        if (!await sql.begin(db => trendContextAllowed(db, job.trend!))) {
          await sql`UPDATE studio_content_imports SET state = 'interrupted', updated_at = now() WHERE id = ${job.id} AND run_token = ${job.token} AND state <> 'ready'`; continue;
        }
        const [priority] = await sql`SELECT id FROM pgboss.job WHERE name = 'studio.creator.collect' AND state IN ('created', 'retry', 'active') LIMIT 1`;
        if (priority) throw new QueueDeferred("先处理已关注博主，再处理热榜发现");
      }
      const [claim] = await sql`UPDATE studio_content_imports SET state = 'running', updated_at = now()
        WHERE id = ${job.id} AND run_token = ${job.token} AND state IN ('queued', 'running') RETURNING *`;
      if (!claim) continue;
      const session = await platformSessionSecret(claim.platform);
      try {
        if (!session.readable) throw new MediaCrawlerFailure("login_required");
        const result = await collectMediaCreator({ platform: claim.platform, locator: claim.platform === "xhs" ? "000000000000000000000000" : claim.platform === "tieba" ? "tb.pending" : "0", videoId: claim.external_id,
          ...(job.searchTerm ? { videoId: undefined, searchTerm: job.searchTerm } : {}), cookie: session.cookie, context: claim.context, discover: true });
        if (result.posts.length !== 1 || !job.searchTerm && result.posts[0]!.externalId !== claim.external_id) throw new Error("作品身份不匹配");
        const homepage = authorHome(claim.platform, result.profile.externalId);
        await sql.begin(async tx => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('studio-topic-media'))`;
          const [current] = await tx`SELECT id FROM studio_content_imports WHERE id = ${job.id} AND run_token = ${job.token} FOR UPDATE`;
          if (!current) return;
          if (!creatorsCollecting() || !await platformSessionUnchanged(tx, claim.platform, session.version) || job.trend && !await trendContextAllowed(tx, job.trend)) {
            await tx`UPDATE studio_content_imports SET state = 'interrupted', updated_at = now() WHERE id = ${job.id}`; return;
          }
          const [alias] = await tx`SELECT creator_id AS id FROM studio_creator_aliases WHERE platform = ${claim.platform} AND locator = ${result.profile.externalId}`;
          if (!alias) await tx`INSERT INTO studio_creator_accounts (id, platform, locator, homepage, name, following, enabled)
            VALUES (${randomUUID()}, ${claim.platform}, ${result.profile.externalId}, ${homepage}, ${result.profile.name}, false, false)
            ON CONFLICT (platform, locator) DO NOTHING`;
          const [account] = alias ? [alias] : await tx`SELECT id FROM studio_creator_accounts WHERE platform = ${claim.platform} AND locator = ${result.profile.externalId}`;
          const identity = await lockCreatorIdentity(tx, account!.id, claim.platform, result.profile);
          const canonical = await bindCreatorIdentity(tx, account!.id, identity, result.profile);
          await tx`UPDATE studio_creator_accounts SET name = COALESCE(name, ${result.profile.name}) WHERE id = ${canonical.id}`;
          const [existing] = await tx`SELECT id FROM studio_creator_posts WHERE creator_id = ${canonical.id} AND external_id = ${result.posts[0]!.externalId}`;
          const postId = existing?.id ?? await saveCreatorContent(tx, canonical.id, claim.platform, result.posts[0]!);
          await tx`UPDATE studio_content_imports SET state = 'ready', post_id = ${postId}, error_code = NULL, updated_at = now() WHERE id = ${job.id}`;
        });
      } catch (error) {
        const code = error instanceof MediaCrawlerFailure ? error.code : error instanceof RepresentativeUnavailable ? "no_representative" : "platform_failed";
        const stillCurrent = await sql.begin(async tx => {
          const current = creatorsCollecting() && await platformSessionUnchanged(tx, claim.platform, session.version)
            && (!job.trend || await trendContextAllowed(tx, job.trend));
          await tx`UPDATE studio_content_imports SET state = ${current ? ["login_required", "rate_limited"].includes(code) ? code : "failed" : "interrupted"},
            error_code = ${current ? code : null}, updated_at = now() WHERE id = ${job.id} AND run_token = ${job.token}`;
          return current;
        });
        if (!stillCurrent) continue;
        throw new Error("单条作品未完成导入，请检查平台登录或网络后重试", { cause: error });
      }
    }
  },
});
