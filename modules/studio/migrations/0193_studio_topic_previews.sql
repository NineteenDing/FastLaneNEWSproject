CREATE TABLE IF NOT EXISTS studio_topic_previews (
  id uuid PRIMARY KEY,
  starts_at timestamptz NOT NULL UNIQUE,
  ends_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  fingerprint text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'draft', 'failed')),
  result jsonb,
  run_token uuid NOT NULL,
  job_id uuid,
  receipt_id bigint REFERENCES receipts(id),
  error text,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
