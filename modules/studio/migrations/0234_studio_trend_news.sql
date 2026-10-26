CREATE TABLE IF NOT EXISTS studio_trend_news (
  signal_id uuid NOT NULL REFERENCES studio_trend_signals(id) ON DELETE CASCADE,
  relevance_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','ready','awaiting_content','failed')),
  article_id text REFERENCES articles(id),
  run_token uuid NOT NULL,
  job_id uuid,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id,relevance_key)
);
