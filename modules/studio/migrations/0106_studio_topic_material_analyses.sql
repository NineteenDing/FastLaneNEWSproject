CREATE TABLE IF NOT EXISTS studio_topic_material_analyses (
  batch_id uuid NOT NULL,
  material_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  job_id uuid,
  result jsonb,
  receipt_id bigint REFERENCES receipts(id),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, material_id),
  FOREIGN KEY (batch_id, material_id) REFERENCES studio_topic_batch_materials(batch_id, material_id)
);
