CREATE TABLE IF NOT EXISTS studio_material_analysis_cache (
  key text PRIMARY KEY,
  material_id text NOT NULL REFERENCES studio_history_index(material_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  result jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
