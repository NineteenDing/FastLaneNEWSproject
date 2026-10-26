CREATE TABLE IF NOT EXISTS studio_creator_identities (
  platform text NOT NULL,
  stable_id text NOT NULL CHECK (length(stable_id) BETWEEN 1 AND 200),
  creator_id uuid NOT NULL UNIQUE REFERENCES studio_creator_accounts(id),
  PRIMARY KEY (platform, stable_id)
);
