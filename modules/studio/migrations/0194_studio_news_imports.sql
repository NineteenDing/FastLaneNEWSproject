CREATE TABLE studio_news_imports (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  url text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  article_id text REFERENCES articles(id),
  run_token uuid NOT NULL,
  job_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
