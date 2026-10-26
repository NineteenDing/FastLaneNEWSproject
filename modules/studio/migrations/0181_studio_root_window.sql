CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS studio_topic_root_window ON studio_topic_batches (starts_at) WHERE root_batch_id IS NULL;
