CREATE TABLE IF NOT EXISTS studio_trend_collection (
  platform text PRIMARY KEY REFERENCES studio_trend_boards(platform),
  state text NOT NULL CHECK (state IN ('running', 'ready', 'failed', 'interrupted')),
  run_token uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  fail_count integer NOT NULL DEFAULT 0,
  item_count integer,
  error_code text
);
