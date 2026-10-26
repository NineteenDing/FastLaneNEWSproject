CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_topic_feedback_recent ON studio_topic_feedback (updated_at DESC, batch_id, direction_id) WHERE rating IS NOT NULL;
