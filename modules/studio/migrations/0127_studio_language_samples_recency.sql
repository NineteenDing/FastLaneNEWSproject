CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_language_samples_recency ON studio_language_samples (confirmed_at DESC, project_id DESC);
