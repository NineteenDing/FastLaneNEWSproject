CREATE TABLE IF NOT EXISTS studio_creator_posts (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES studio_creator_accounts(id),
  external_id text NOT NULL,
  content jsonb NOT NULL,
  content_fingerprint text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, external_id)
);
