CREATE TABLE IF NOT EXISTS studio_news_image_sets (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  version_key text NOT NULL,
  revision integer NOT NULL,
  article_url text NOT NULL,
  candidates jsonb NOT NULL,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'ready', 'failed')),
  job_id uuid,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, version_key)
);
