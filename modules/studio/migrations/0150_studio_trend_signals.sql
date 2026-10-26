CREATE TABLE IF NOT EXISTS studio_trend_signals (
  id uuid PRIMARY KEY,
  platform text NOT NULL REFERENCES studio_trend_boards(platform),
  external_id text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  disposition text NOT NULL DEFAULT 'pending_relevance',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
