CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_history_terms ON studio_history_index USING gin (terms);
