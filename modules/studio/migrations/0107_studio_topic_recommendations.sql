CREATE TABLE IF NOT EXISTS studio_topic_recommendations (
  batch_id uuid PRIMARY KEY REFERENCES studio_topic_batches(id),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'draft', 'failed')),
  job_id uuid,
  result jsonb,
  receipt_id bigint REFERENCES receipts(id),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
