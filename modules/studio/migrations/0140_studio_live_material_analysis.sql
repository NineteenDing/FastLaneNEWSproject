CREATE TABLE IF NOT EXISTS studio_live_material_analyses (
  material_id text NOT NULL REFERENCES studio_history_index(material_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'running', 'completed', 'failed', 'superseded', 'waiting_body')),
  snapshot jsonb,
  result jsonb,
  receipt_id bigint REFERENCES receipts(id),
  job_id uuid,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, source_key)
);
