CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_trend_observation_recent ON studio_trend_observations (signal_id, observed_at DESC, id DESC);
