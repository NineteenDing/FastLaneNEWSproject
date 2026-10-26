CREATE TABLE IF NOT EXISTS studio_filter_policy_versions (
  version integer PRIMARY KEY,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
