CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_live_analysis_pending
  ON studio_live_material_analyses (requested_at, material_id, source_key) WHERE state = 'pending';
