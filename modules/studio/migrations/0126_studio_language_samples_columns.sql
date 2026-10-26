CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_language_samples_columns ON studio_language_samples USING gin (column_ids);
