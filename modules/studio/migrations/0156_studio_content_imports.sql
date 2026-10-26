CREATE TABLE IF NOT EXISTS studio_content_imports (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  external_id text NOT NULL,
  url text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed', 'interrupted', 'login_required', 'rate_limited')),
  post_id uuid REFERENCES studio_creator_posts(id),
  run_token uuid NOT NULL,
  job_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
