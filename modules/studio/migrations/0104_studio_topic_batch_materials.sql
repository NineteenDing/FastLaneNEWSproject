CREATE TABLE IF NOT EXISTS studio_topic_batch_materials (
  batch_id uuid NOT NULL REFERENCES studio_topic_batches(id),
  material_id text NOT NULL,
  collected_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  PRIMARY KEY (batch_id, material_id)
);
