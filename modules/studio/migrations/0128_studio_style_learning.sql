CREATE TABLE IF NOT EXISTS studio_style_learning (
  id uuid PRIMARY KEY,
  column_id text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'candidate', 'activated', 'retained', 'failed')),
  result jsonb,
  error text,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (column_id, input_hash)
);
