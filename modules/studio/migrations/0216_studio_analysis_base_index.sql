CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_analysis_base_idx ON studio_material_analysis_cache (base_key, created_at DESC);
