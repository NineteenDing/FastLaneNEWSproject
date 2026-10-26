CREATE TABLE studio_source_metadata (
  source_id text PRIMARY KEY REFERENCES sources(id),
  config_fingerprint text NOT NULL,
  requested_homepage text,
  description text,
  language text,
  homepage text,
  icon_key text,
  icon_type text,
  state text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
