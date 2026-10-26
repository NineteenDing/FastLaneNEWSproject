CREATE TABLE IF NOT EXISTS studio_writing_skills (
  id text NOT NULL,
  version integer NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
