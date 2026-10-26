import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type { TopicDirection, TopicFeedback, TopicFeedbackSample, TopicAdoptionSample, TopicRecommendationResult } from "../contracts.ts";

const directionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const inputSchema = z.object({ version: z.number().int().nonnegative(), rating: z.enum(["useful", "not_useful"]).nullable(), reason: z.string().trim().max(1000) }).strict();
type Saved = { version: number; rating: TopicFeedback["rating"]; reason: string; updatedAt: Date };
const project = (row?: Saved): TopicFeedback => row ? { ...row, updatedAt: row.updatedAt.toISOString() } : { version: 0, rating: null, reason: "", updatedAt: null };

async function reviewedDirection(db: Db, batchId: string, directionId: string): Promise<TopicDirection | undefined> {
  const [review] = await db<{ result: TopicRecommendationResult }[]>`SELECT output->'result' AS result FROM studio_topic_reviews WHERE batch_id = ${batchId} AND state = 'completed'`;
  return review?.result?.directions.find(direction => direction.id === directionId);
}

export async function topicFeedback(batchId: string, directionId: string) {
  z.uuid().parse(batchId); directionIdSchema.parse(directionId);
  if (!await reviewedDirection(sql, batchId, directionId)) return null;
  const [row] = await sql<Saved[]>`SELECT version, rating, reason, updated_at AS "updatedAt" FROM studio_topic_feedback WHERE batch_id = ${batchId} AND direction_id = ${directionId}`;
  return { feedback: project(row) };
}

/** Explicit feedback only. The reviewed result and writing snapshots are never updated. */
export async function saveTopicFeedback(batchId: string, directionId: string, input: unknown, actor: string) {
  z.uuid().parse(batchId); directionIdSchema.parse(directionId); const changes = inputSchema.parse(input);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`studio.topic.feedback:${batchId}:${directionId}`}, 0))`;
    const direction = await reviewedDirection(db, batchId, directionId); if (!direction) return null;
    const [before] = await db<Saved[]>`SELECT version, rating, reason, updated_at AS "updatedAt" FROM studio_topic_feedback WHERE batch_id = ${batchId} AND direction_id = ${directionId}`;
    if ((before?.version ?? 0) !== changes.version) throw new Conflict("选题反馈已被其他窗口修改，请刷新反馈后再保存");
    const snapshot = { columnId: direction.columnId, eventKey: direction.eventKey, question: direction.question, angle: direction.angle };
    const [saved] = await db<Saved[]>`INSERT INTO studio_topic_feedback (batch_id, direction_id, version, rating, reason, direction)
      VALUES (${batchId}, ${directionId}, ${changes.version + 1}, ${changes.rating}, ${changes.reason}, ${db.json(snapshot)})
      ON CONFLICT (batch_id, direction_id) DO UPDATE SET version = EXCLUDED.version, rating = EXCLUDED.rating, reason = EXCLUDED.reason, updated_at = now()
      RETURNING version, rating, reason, updated_at AS "updatedAt"`;
    await audit(actor, "studio.topic.feedback", `batch:${batchId}:direction:${directionId}`, null, project(before), project(saved), { db });
    return { feedback: project(saved) };
  });
}

/** Bounded recent metadata only, once at submission. No bodies, implicit dislikes or model call. */
export async function freezeTopicFeedback(db: Db, batchId: string): Promise<TopicFeedbackSample[]> {
  const rows = await db<TopicFeedbackSample[]>`SELECT batch_id AS "batchId", direction_id AS "directionId", version, rating, reason, direction
    FROM studio_topic_feedback WHERE rating IS NOT NULL AND batch_id <> ${batchId}
      AND updated_at >= ${new Date(Date.now() - 90 * 86400000)}
    ORDER BY updated_at DESC, batch_id, direction_id LIMIT 50`;
  const samples: TopicFeedbackSample[] = []; let bytes = 2;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (bytes + size > 12000) continue;
    samples.push(row); bytes += size;
    if (samples.length === 20) break;
  }
  return samples;
}

/** Read small actual adoption snapshots, not every historical body or unchosen direction. */
export async function freezeTopicAdoptions(db: Db, batchId: string): Promise<TopicAdoptionSample[]> {
  const rows = await db<TopicAdoptionSample[]>`WITH recent AS MATERIALIZED (
      SELECT id, batch_id, created_at, snapshot FROM studio_writing_projects WHERE batch_id <> ${batchId} ORDER BY created_at DESC, id LIMIT 20
    ) SELECT p.id AS "projectId", p.batch_id AS "batchId", d->>'id' AS "directionId", d->>'columnId' AS "columnId",
      d->>'eventKey' AS "eventKey", d->>'angle' AS angle,
      coalesce((SELECT jsonb_agg(r->>'quote') FROM jsonb_array_elements(d->'references') r WHERE r->>'role' = 'fact'), '[]'::jsonb) AS quotes
    FROM recent p CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'directions') d ORDER BY p.created_at DESC, p.id, d->>'id'`;
  const samples: TopicAdoptionSample[] = []; let size = 2;
  for (const row of rows) {
    const length = JSON.stringify(row).length + 1;
    if (!row.quotes.length || size + length > 6000) continue;
    samples.push(row); size += length;
    if (samples.length === 20) break;
  }
  return samples;
}
