CREATE TABLE IF NOT EXISTS studio_shared_analysis_contexts (
  key text PRIMARY KEY,
  input jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
