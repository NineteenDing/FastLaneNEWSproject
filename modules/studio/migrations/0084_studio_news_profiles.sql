-- Private editorial descriptions, separate from collector configuration and public exports.
CREATE TABLE studio_news_profiles (
  source_id text PRIMARY KEY REFERENCES sources(id),
  description text,
  region text,
  language text,
  homepage text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
