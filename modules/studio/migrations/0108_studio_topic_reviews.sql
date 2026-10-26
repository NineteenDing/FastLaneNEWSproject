CREATE TABLE IF NOT EXISTS studio_topic_reviews (
  batch_id uuid PRIMARY KEY REFERENCES studio_topic_batches(id),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  job_id uuid,
  output jsonb,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
