CREATE TABLE IF NOT EXISTS studio_trend_relevance (
  signal_id uuid NOT NULL REFERENCES studio_trend_signals(id),
  context_key text NOT NULL,
  input jsonb NOT NULL,
  run_token uuid NOT NULL,
  job_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'completed', 'failed', 'superseded')),
  result jsonb,
  receipt_id bigint REFERENCES receipts(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, context_key)
);
