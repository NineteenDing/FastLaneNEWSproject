CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_history_title ON studio_history_index USING gin (normalized_title gin_trgm_ops);
