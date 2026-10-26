CREATE TABLE IF NOT EXISTS studio_history_rebuild (
  scope text PRIMARY KEY CHECK (scope = 'all'),
  id uuid NOT NULL UNIQUE,
  policy text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  phase text NOT NULL CHECK (phase IN ('news', 'creator', 'done')),
  news_upper text,
  creator_upper uuid,
  cursor text,
  processed bigint NOT NULL DEFAULT 0,
  job_id uuid NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
