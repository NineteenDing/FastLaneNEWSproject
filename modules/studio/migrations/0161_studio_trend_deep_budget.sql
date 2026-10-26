CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_trend_deep_budget_idx ON studio_trend_deep_reads (budget_day) WHERE charged;
