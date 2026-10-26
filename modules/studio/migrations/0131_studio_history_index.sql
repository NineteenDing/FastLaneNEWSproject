CREATE TABLE IF NOT EXISTS studio_history_index (
  material_id text PRIMARY KEY,
  article_id text UNIQUE REFERENCES articles(id) ON DELETE CASCADE,
  post_id uuid UNIQUE REFERENCES studio_creator_posts(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz,
  collected_at timestamptz NOT NULL,
  content_version jsonb NOT NULL,
  fingerprint text NOT NULL,
  terms text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((article_id IS NOT NULL AND post_id IS NULL AND material_id = 'news:' || article_id)
    OR (article_id IS NULL AND post_id IS NOT NULL AND material_id = 'creator:' || post_id::text))
);
