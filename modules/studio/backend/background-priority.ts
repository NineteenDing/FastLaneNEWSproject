import { sql, type Db } from "@aihot/backend/db";

/** Reused from the existing weekly learning admission: ingestion and user-facing work run first. */
export async function backgroundWorkHasPriority(db: Db = sql) {
  const [row] = await db<{ allowed: boolean }[]>`SELECT NOT EXISTS (SELECT 1 FROM pgboss.job WHERE state IN ('created', 'retry', 'active')
    AND name IN ('studio.writing.generate', 'studio.writing.revise', 'studio.topic.freeze', 'studio.topic.material-analysis', 'studio.topic.generate', 'studio.topic.review',
      'sources.fetch', 'sources.fetch-x', 'sources.mp', 'content.extract-body', 'studio.creator.collect', 'studio.rsshub.collect', 'studio.media.process')) AS allowed`;
  return row!.allowed;
}
