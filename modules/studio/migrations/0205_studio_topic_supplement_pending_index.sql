CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_topic_supplement_pending_idx ON studio_topic_supplement_imports (updated_at, id) WHERE state NOT IN ('applied', 'failed');
