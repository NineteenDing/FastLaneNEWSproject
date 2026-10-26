import { sql } from "@aihot/backend/db";
import { modelBudgetReport } from "@aihot/backend/providers/llm-budget";
import { modelRequestStatus } from "@aihot/backend/providers/model-requests";
import { modelOperations } from "./model-operations.ts";
import type { ModelUsage } from "../contracts.ts";

const labels = { analysis: "材料分析", topics: "选题综合", review: "独立审核", writing: "口播写作", learning: "风格学习", other: "新闻与其他" } as const;
function group(purpose: string): keyof typeof labels {
  if (purpose === "studio_material_analysis" || purpose === "studio_trend_relevance") return "analysis";
  if (purpose === "studio_topic_generation") return "topics";
  if (purpose === "studio_topic_review") return "review";
  if (purpose.startsWith("studio_writing_")) return "writing";
  if (purpose.startsWith("studio_style_")) return "learning";
  return "other";
}

/** Aggregate existing records only. Reading settings never calls the model or starts a broker. */
export async function modelUsage(): Promise<ModelUsage> {
  const report = modelBudgetReport();
  const since = new Date(`${report.month}-01T00:00:00+08:00`);
  const [concurrency, operations, usage, queues] = await Promise.all([
    modelRequestStatus(), modelOperations(),
    sql<{ purpose: string; attempts: number; input: number; output: number; missing: number; unknown: number }[]>`
      SELECT r.purpose, count(*)::int AS attempts,
        coalesce(sum(CASE WHEN (a.usage->>'prompt_tokens') ~ '^[0-9]{1,15}$' THEN (a.usage->>'prompt_tokens')::bigint END), 0) AS input,
        coalesce(sum(CASE WHEN (a.usage->>'completion_tokens') ~ '^[0-9]{1,15}$' THEN (a.usage->>'completion_tokens')::bigint END), 0) AS output,
        count(*) FILTER (WHERE a.usage IS NULL OR NOT coalesce((a.usage->>'prompt_tokens') ~ '^[0-9]{1,15}$', false)
          OR NOT coalesce((a.usage->>'completion_tokens') ~ '^[0-9]{1,15}$', false))::int AS missing,
        count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL GROUP BY r.purpose`,
    sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
  ]);
  const rows = Object.entries(labels).map(([key, label]) => ({ key, label, attemptsThisMonth: 0, inputTokensThisMonth: 0,
    outputTokensThisMonth: 0, missingUsageAttempts: 0, unknownAttempts: 0, estimatedToday: 0, estimatedThisMonth: 0, reservedToday: 0, reservedThisMonth: 0 }));
  for (const entry of usage) {
    const row = rows.find(row => row.key === group(entry.purpose))!;
    row.attemptsThisMonth += entry.attempts; row.inputTokensThisMonth += entry.input; row.outputTokensThisMonth += entry.output;
    row.missingUsageAttempts += entry.missing; row.unknownAttempts += entry.unknown;
  }
  for (const entry of report.purposes) {
    const row = rows.find(row => row.key === group(entry.purpose))!;
    row.estimatedToday += entry.estimatedToday; row.estimatedThisMonth += entry.estimatedThisMonth;
    row.reservedToday += entry.reservedToday; row.reservedThisMonth += entry.reservedThisMonth;
  }
  const [tasks] = queues[0]?.present ? await sql<{ queued: number; active: number }[]>`SELECT
    count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
    count(*) FILTER (WHERE state = 'active')::int AS active FROM pgboss.job
    WHERE name IN ('studio.topic.material-analysis', 'studio.trends.relevance', 'studio.topic.generate', 'studio.topic.review', 'studio.writing.generate', 'studio.writing.revise', 'studio.style.learn', 'studio.creator.expressions', 'studio.reference.vision')` : [{ queued: 0, active: 0 }];
  return { currency: "CNY", timeZone: "Asia/Hong_Kong", day: report.day, month: report.month,
    budget: report.budget, rows, concurrency, modelEnabled: operations.enabled, tasks: tasks! };
}
