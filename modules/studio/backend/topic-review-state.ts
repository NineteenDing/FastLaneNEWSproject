import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { modelWorkAllowed } from "./model-operations.ts";
import { frozenTopicReferences } from "./topic-batches.ts";
import type { TopicReview, TopicReviewOpinion } from "../contracts.ts";

/** Read-only progress/result projection; opening a page never starts or retries a model task. */
export async function topicReview(batchId: string): Promise<TopicReview | null> {
  z.uuid().parse(batchId);
  return sql.begin("isolation level repeatable read read only", async db => {
    const [batch] = await db`SELECT id FROM studio_topic_batches WHERE id = ${batchId}`;
    if (!batch) return null;
    const [row] = await db<{ state: TopicReview["state"]; output: Pick<TopicReview, "verdict" | "result" | "rounds" | "decisions" | "summary"> | null;
      error: string | null; jobId: string | null }[]>`SELECT state, output, error, job_id AS "jobId" FROM studio_topic_reviews WHERE batch_id = ${batchId}`;
    const [job] = row?.jobId && !row.output ? await db`SELECT state FROM pgboss.job WHERE name = 'studio.topic.review' AND id = ${row.jobId}` : [];
    const steps = await db<{ step: string; opinions: TopicReviewOpinion[] | null; passed: boolean | null; summary: string | null }[]>`
      SELECT step, result->'opinions' AS opinions, (result->>'passed')::boolean AS passed, result->>'summary' AS summary
      FROM studio_topic_review_steps WHERE batch_id = ${batchId} ORDER BY step`;
    const rounds: TopicReview["rounds"] = [];
    for (const round of [1, 2] as const) {
      const summary = steps.find(step => step.step === `round:${round}:summary`);
      if (summary) rounds.push({ round, passed: summary.passed!, summary: summary.summary!, opinions: steps
        .filter(step => step.step.startsWith(`round:${round}:packet:`)).flatMap(step => (step.opinions ?? []).map(item => ({ ...item, id: `${round}:${step.step.split(":").at(-1)}:${item.id}` }))) });
    }
    const interrupted = row && !row.output && !["created", "retry", "active"].includes(job?.state ?? "missing");
    const referenceMaterials = await frozenTopicReferences(db, batchId, [...(row?.output?.result?.directions.flatMap(direction => direction.references.map(ref => ref.materialId)) ?? []), ...(row?.output?.result?.assignments.map(item => item.materialId) ?? [])]);
    return { state: interrupted ? "failed" : row?.state ?? "not_started", verdict: null, result: null, rounds, decisions: [], summary: null,
      ...row?.output, completedSteps: steps.length, referenceMaterials, error: row?.error ?? (interrupted ? "审核任务已中断，可显式重试" : null), modelEnabled: await modelWorkAllowed(db) };
  });
}
