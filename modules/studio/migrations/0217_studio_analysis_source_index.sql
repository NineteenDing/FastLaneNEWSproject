CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_analysis_source_idx ON studio_material_analysis_cache (source_key, created_at DESC);
