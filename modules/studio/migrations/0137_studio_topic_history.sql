CREATE TABLE IF NOT EXISTS studio_topic_history (
  batch_id uuid PRIMARY KEY REFERENCES studio_topic_batches(id) ON DELETE CASCADE,
  candidate_limit integer NOT NULL DEFAULT 50 CHECK (candidate_limit BETWEEN 1 AND 50),
  evidence_limit integer NOT NULL DEFAULT 10 CHECK (evidence_limit BETWEEN 1 AND 10 AND evidence_limit <= candidate_limit),
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
