CREATE TABLE IF NOT EXISTS studio_creator_expressions (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES studio_creator_accounts(id),
  context_key text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  result jsonb,
  receipt_id bigint,
  job_id uuid NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, context_key)
);
