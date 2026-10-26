// Bounded editorial-v2 backfill. Dry-run by default; --execute pays only for current live materials
// whose shared understanding lacks v2 fields. Frozen batch versions and published reports are untouched.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import type { TopicBatchMaterial } from "../contracts.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const limitArg = [...args].find(value => value.startsWith("--limit="))?.slice("--limit=".length);
const limit = Math.min(25, Math.max(1, Number(limitArg ?? 25) || 25));

const env = parseEnv(await readFile(path.join(root, ".env"), "utf8"));
if (env.MODEL_CALLS_ENABLED !== "true" && execute) throw new Error("MODEL_CALLS_DISABLED");
const target = new URL(env.DATABASE_URL ?? "");
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "[::1]"].includes(target.hostname)
  || target.pathname !== "/studio_local") throw new Error("LOCAL_DATABASE_REFUSED");
Object.assign(process.env, localProcessEnvironment(), env);

const { sql, closeDb } = await import("@aihot/backend/db");
const { audit } = await import("@aihot/backend/audit");
// Publication projection needs the installed server modules; a bare script otherwise writes decisions only.
const { installModules } = await import("@aihot/backend/modules");
const { SERVER_MODULES } = await import("@aihot/site/modules/server");
installModules(SERVER_MODULES);
const { topicPlan, topicDurationMs } = await import("../backend/topic-plan.ts");
const { currentColumns, topicAudience } = await import("../backend/topic-columns.ts");
const { intelligenceEvidence } = await import("../backend/intelligence.ts");
const { historyEvidenceKey } = await import("../backend/history-entities.ts");
const { analyzeMaterialEvidence, materialAnalysisCachePolicy, prepareMaterialAnalysis } = await import("../backend/material-analysis.ts");
const { studioChatJson } = await import("../backend/studio-model.ts");
const { columnSemanticsKey } = await import("../backend/column-matching.ts");
const { sharedMaterialSchema } = await import("../backend/shared-material.ts");
const { ReceiptBusyError, ReceiptUnknownError, BudgetExceededError } = await import("@aihot/backend/providers/receipts");
const { QueueDeferred } = await import("@aihot/backend/jobs/queue");
const deferred = (error: unknown) => error instanceof ReceiptBusyError || error instanceof ReceiptUnknownError || error instanceof BudgetExceededError || error instanceof QueueDeferred;

type Candidate = { materialId: string; sourceKey: string; collectedAt: Date; existing: Record<string, unknown> | null };

const text = z.string().trim().min(1).max(500);
const v2Dim = z.object({ value: z.number().min(0).max(100).nullable(), reason: text,
  factIds: z.array(z.number().int().nonnegative()).max(20).optional() });
// Compatible Flash responses return a bare score or omit reasons; normalize without inventing evidence.
const dimLike = z.preprocess(value => typeof value === "number" ? { value, reason: "模型仅返回分值" }
  : value && typeof value === "object" && "score" in value && !("value" in value) ? { ...(value as object), value: (value as { score: unknown }).score }
  : value, v2Dim.optional());
const scopeEnum = z.enum(["direct_ai_film", "general_ai", "non_ai_film", "unrelated", "uncertain"]);
const extensionSchema = z.object({
  editorialScope: scopeEnum.optional(),
  aiCentral: z.preprocess(value => typeof value === "string" ? !/^(fail|no|false|不通过|否|不满足)/i.test(value.trim()) : value, z.boolean().optional()),
  filmRelevant: z.preprocess(value => typeof value === "string" ? !/^(fail|no|false|不通过|否|不满足)/i.test(value.trim()) : value, z.boolean().optional()),
  v2: z.preprocess(value => value && typeof value === "object" ? value : {}, z.object({ I: dimLike, M: dimLike, D: dimLike, P: dimLike, E: dimLike, X: dimLike })),
  publicSummary: z.string().trim().min(1).max(300).optional(),
  summaryFactIds: z.array(z.number().int().nonnegative()).max(20).optional(),
  primaryIntent: z.enum(["practice", "models", "news", "cases", "other"]).optional(),
  majorEvent: z.any().optional(),
});
const forbiddenSummary = /值得精选|相关性较弱|可作为选题背景|潜在参考价值|建议创作者|模型评分|入选理由|值得关注/;

async function extendExisting(candidate: Candidate, shared: Record<string, unknown>, body: string) {
  const facts = Array.isArray(shared.facts) ? shared.facts as Array<{ text: string; quotes: string[] }> : [];
  if (!facts.length) throw new Error("现有分析没有可复用事实");
  const output = await studioChatJson("studioMaterialAnalysis", { purpose: "studio_material_analysis",
    subject: `studio-backfill-v2:${candidate.materialId}:extension`, promptVersion: "studio-material-v2-extension",
    system: "你为已保存的AI影视材料补充editorial-v2语义，不重新提取或改写事实。" +
      "只依据给定正文与existing.facts，不新增事实、数字、日期或引用，不写评分、推荐或选题结论。" +
      "editorialScope：direct_ai_film=明确直接AI影视且AI是核心；general_ai=AI是主体但非直接AI影视；non_ai_film=影视音乐漫剧相关但AI非核心；unrelated/uncertain。" +
      "direct_ai_film须aiCentral与filmRelevant都true，general_ai须aiCentral=true，non_ai_film须filmRelevant=true，否则不得使用该scope。" +
      "v2为I受众兴趣、M影响重要性、D实质信息、P可操作价值、E证据支撑、X表达与新增空间，每项value 0至100或null，reason简述，factIds指向existing.facts下标；无实操内容P=0是明确不适用，不得为过线倒推。" +
      "publicSummary只写80至180个中文字符（硬上限300）的新闻事实及明确归因的原文观点，不写相关性、推荐、选题、评分或“值得关注”；summaryFactIds指向支持摘要的事实下标。" +
      "majorEvent仅在已核实的重大模型发布、约束性政策、重大事故、重大平台或行业变化时输出，否则null；普通融资、名人表态、预告、估值变化不是重大。" +
      "primaryIntent按文章主要问题选practice/models/news/cases/other。只返回JSON。",
    user: JSON.stringify({ task: "editorial_v2_extension", audience: topicAudience,
      material: { title: String((shared as { label?: string }).label ?? ""), body: body.slice(0, 16000) },
      existing: { scope: shared.scope, scopeReason: shared.scopeReason, facts, event: shared.event,
        reportingKind: shared.reportingKind, publicDimensions: shared.publicDimensions, impact: shared.impact } }),
    schema: extensionSchema, maxTokens: 2500 });
  const ext = output.data;
  const oldScope = shared.scope;
  const scope = ext.editorialScope ?? (oldScope === "direct" ? "direct_ai_film" : oldScope === "important_ai" ? "general_ai"
    : oldScope === "unrelated" ? "unrelated" : "uncertain");
  // Do not invent consistency flags from scope. Contradictory or missing evidence fails validation.
  const aiCentral = ext.aiCentral ?? shared.aiCentral;
  const filmRelevant = ext.filmRelevant ?? shared.filmRelevant;
  const dim = (value: z.infer<typeof v2Dim> | undefined) => ({ value: value?.value ?? null,
    reason: value?.reason ?? "模型未返回该维度", factIds: value?.factIds?.filter(index => index < facts.length) });
  const v2 = { I: dim(ext.v2.I), M: dim(ext.v2.M), D: dim(ext.v2.D), P: dim(ext.v2.P), E: dim(ext.v2.E), X: dim(ext.v2.X) };
  if ([v2.I, v2.M, v2.D, v2.P].some(item => item.value === null)) throw new Error("v2核心维度缺失");
  const summary = ext.publicSummary && !forbiddenSummary.test(ext.publicSummary) ? ext.publicSummary
    : facts.slice(0, 4).map(fact => fact.text).join("；").slice(0, 300);
  if (!summary) throw new Error("没有可用的公开事实摘要");
  const summaryFactIds = (ext.summaryFactIds ?? facts.slice(0, 4).map((_fact, index) => index)).filter(index => index < facts.length).slice(0, 20);
  const major = ext.majorEvent && typeof ext.majorEvent === "object" && Array.isArray(ext.majorEvent.evidenceFactIds)
    && ext.majorEvent.evidenceFactIds.every((index: number) => index >= 0 && index < facts.length) ? ext.majorEvent : null;
  const base = { ...shared };
  delete base.insights; delete base.dimensions; delete base.policy;
  const merged = sharedMaterialSchema.safeParse({ ...base, editorialScope: scope, aiCentral, filmRelevant, v2,
    publicSummary: summary, summaryFactIds, primaryIntent: ext.primaryIntent ?? "news", majorEvent: major });
  if (!merged.success) throw new Error("合并v2语义失败：" + (merged.error.issues[0]?.message ?? "格式错误"));
  return { shared: { ...merged.data, policy: materialAnalysisCachePolicy }, receiptId: output.receiptId };
}
try {
  const columns = await currentColumns(sql), plan = await topicPlan(sql), anchor = Date.parse(plan.startsAt);
  const candidates = await sql<Candidate[]>`
    SELECT h.material_id AS "materialId", h.knowledge->>'sourceKey' AS "sourceKey", h.collected_at AS "collectedAt",
      l.result AS existing
    FROM studio_history_index h
    JOIN articles a ON a.id = h.article_id JOIN sources s ON s.id = a.source_id
    LEFT JOIN studio_public_news pn ON pn.article_id = a.id
    LEFT JOIN studio_live_material_analyses l ON l.material_id = h.material_id AND l.source_key = h.knowledge->>'sourceKey'
    WHERE h.collected_at >= now() - interval '120 hours' AND a.body_status = 'ok' AND s.participation_mode = 'editorial'
      AND NOT EXISTS (SELECT 1 FROM studio_topic_batch_materials m WHERE m.material_id = h.material_id AND m.source_key = h.knowledge->>'sourceKey')
      AND coalesce(l.state, '') NOT IN ('waiting_body', 'failed')
      -- Old unrelated material stays out of the public pool; re-paying to re-confirm it is not a current release blocker.
      AND l.result->'shared'->>'scope' IS DISTINCT FROM 'unrelated'
      AND (l.result IS NULL OR l.result->'shared'->>'editorialScope' IS NULL OR l.result->'shared'->'v2' IS NULL
        OR l.result->'shared'->>'publicSummary' IS NULL)
    ORDER BY (pn.decision->>'allowed' = 'true') DESC, h.collected_at DESC, h.material_id LIMIT ${limit}`;
  const missingBody = candidates.filter(candidate => !candidate.sourceKey);
  const summary = { target: "studio_local", mode: execute ? "execute" : "dry-run", limit, modelEnabled: env.MODEL_CALLS_ENABLED === "true",
    candidates: candidates.length, missingSourceKey: missingBody.length, analyzed: 0, skipped: 0, failed: 0,
    receiptIds: [] as number[], errors: [] as string[] };
  if (!execute) {
    console.log(JSON.stringify({ ...summary, items: candidates.map(candidate => ({ materialId: candidate.materialId,
      published: candidate.collectedAt.toISOString(), action: "would_reanalyze" })) }));
  } else {
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++]!;
        if (!candidate.sourceKey) { summary.skipped++; continue; }
        const startsAt = new Date(anchor + Math.floor((candidate.collectedAt.getTime() - anchor) / topicDurationMs) * topicDurationMs);
        const [row] = await sql.begin("isolation level repeatable read read only", db =>
          db<{ evidence: TopicBatchMaterial }[]>`SELECT evidence FROM (${intelligenceEvidence(db,
            { earliestStart: candidate.collectedAt, startsAt, endsAt: new Date(candidate.collectedAt.getTime() + 1) }, [candidate.materialId])}) materials`);
        if (!row || historyEvidenceKey(row.evidence) !== candidate.sourceKey || !["ok", "collected", "transcribed"].includes(row.evidence.bodyState)
          || !row.evidence.body.trim()) {
          await sql`INSERT INTO studio_live_material_analyses (material_id, source_key, state, error, updated_at)
            VALUES (${candidate.materialId}, ${candidate.sourceKey}, 'waiting_body', '正文未就绪，等待重判', now())
            ON CONFLICT (material_id, source_key) DO UPDATE SET state = 'waiting_body', error = EXCLUDED.error, updated_at = now()`;
          summary.skipped++;
          console.error(JSON.stringify({ materialId: candidate.materialId, status: "waiting_body" }));
          continue;
        }
        // Backfill only the shared understanding used by public scoring; insights are not needed and stay private.
        const context = { evidence: row.evidence, audience: topicAudience, columns, sharedPolicy: materialAnalysisCachePolicy };
        const persist = async (result: unknown, receiptId: number, mode: "existing_shared" | "full") => sql.begin(async db => {
          await db`INSERT INTO studio_live_material_analyses (material_id, source_key, state, result, receipt_id, snapshot, error, updated_at)
            VALUES (${candidate.materialId}, ${candidate.sourceKey}, 'completed', ${db.json(result as never)}, ${receiptId}, NULL, NULL, now())
            ON CONFLICT (material_id, source_key) DO UPDATE SET state = 'completed', result = EXCLUDED.result, receipt_id = EXCLUDED.receipt_id,
              snapshot = NULL, error = NULL, updated_at = now()`;
          await audit("system:editorial-v2-backfill", "studio.material.analysis.backfill", candidate.materialId, null, null,
            { receiptId, policy: materialAnalysisCachePolicy, mode }, { db });
        });
        let saved = false, lastError = "", blocked = false;
        const existingShared = (candidate.existing as { shared?: Record<string, unknown> } | null)?.shared;
        if (Array.isArray(existingShared?.facts) && existingShared.facts.length) {
          for (let attempt = 0; attempt < 2 && !saved; attempt++) {
            try {
              const extended = await extendExisting(candidate, existingShared, row.evidence.body);
              const result = { ...(candidate.existing as Record<string, unknown>), shared: extended.shared,
                columnSemanticsKey: columnSemanticsKey(columns) };
              await persist(result, extended.receiptId, "existing_shared");
              summary.analyzed++; summary.receiptIds.push(extended.receiptId); saved = true;
              console.error(JSON.stringify({ materialId: candidate.materialId, status: "extended", receiptId: extended.receiptId, attempt: attempt + 1 }));
            } catch (error) {
              lastError = (error instanceof Error ? error.message : "unknown").replace(/\s+/g, " ").slice(0, 200);
              console.error(JSON.stringify({ materialId: candidate.materialId, status: "extension_failed", error: lastError }));
              if (deferred(error)) { blocked=true; break; }
            }
          }
        }
        for (let attempt = 0; attempt < 2 && !saved && !blocked; attempt++) {
          try {
            const prepared = await prepareMaterialAnalysis(context);
            const output = await analyzeMaterialEvidence(context, `studio-backfill-v2:${candidate.materialId}`, prepared);
            const shared = (output.result as { shared?: { editorialScope?: string; v2?: unknown } }).shared;
            if (!shared?.editorialScope || !shared.v2) throw new Error("共享分析缺少v2字段");
            await persist(output.result, output.receiptId, "full");
            summary.analyzed++; summary.receiptIds.push(output.receiptId); saved = true;
            console.error(JSON.stringify({ materialId: candidate.materialId, status: "analyzed", receiptId: output.receiptId, attempt: attempt + 1 }));
          } catch (error) {
            lastError = (error instanceof Error ? error.message : "unknown").replace(/\s+/g, " ").slice(0, 200);
            if (deferred(error) || attempt === 1) break;
          }
        }
        if (!saved) {
          summary.failed++; summary.errors.push(lastError);
          console.error(JSON.stringify({ materialId: candidate.materialId, status: "failed" }));
          await sql`INSERT INTO studio_live_material_analyses (material_id, source_key, state, error, updated_at)
            VALUES (${candidate.materialId}, ${candidate.sourceKey}, 'failed', '二期重判未完成，需人工重试', now())
            ON CONFLICT (material_id, source_key) DO UPDATE SET state = 'failed', error = EXCLUDED.error, updated_at = now()`;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    const { reconcilePublicNews } = await import("../backend/public-news.ts");
    summary.receiptIds = [...new Set(summary.receiptIds)];
    console.log(JSON.stringify({ ...summary, reconciled: (await reconcilePublicNews()).processed }));
  }
} finally {
  await closeDb();
}
