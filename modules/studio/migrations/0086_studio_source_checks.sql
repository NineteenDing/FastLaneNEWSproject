CREATE TABLE IF NOT EXISTS studio_source_checks (
  source_id text PRIMARY KEY REFERENCES sources(id),
  config_fingerprint text NOT NULL,
  state text NOT NULL,
  checked_at timestamptz NOT NULL,
  item_count integer
);
