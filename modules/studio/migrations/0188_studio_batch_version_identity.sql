CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS studio_topic_batch_version_identity ON studio_topic_batches (root_batch_id, revision) WHERE root_batch_id IS NOT NULL;
