CREATE TABLE IF NOT EXISTS studio_creator_collection (
  creator_id uuid PRIMARY KEY REFERENCES studio_creator_accounts(id),
  run_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'ready', 'failed', 'interrupted', 'login_required', 'rate_limited')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  next_page integer NOT NULL DEFAULT 1 CHECK (next_page BETWEEN 1 AND 10000),
  coverage jsonb,
  error_code text CHECK (error_code IS NULL OR error_code IN ('platform_failed', 'login_required', 'rate_limited'))
);
