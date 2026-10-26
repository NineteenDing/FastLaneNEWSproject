CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_shared_event_terms_idx ON studio_shared_events USING gin(terms);
