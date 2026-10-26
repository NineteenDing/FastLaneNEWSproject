CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_creator_observations_post_time ON studio_creator_observations (post_id, observed_at DESC, id DESC);
