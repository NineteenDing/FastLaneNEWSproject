CREATE TABLE IF NOT EXISTS studio_media_jobs (
  post_id uuid PRIMARY KEY REFERENCES studio_creator_posts(id),
  source_fingerprint text NOT NULL,
  job_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
