CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_creator_expressions_recent ON studio_creator_expressions(creator_id, created_at DESC, id DESC);
