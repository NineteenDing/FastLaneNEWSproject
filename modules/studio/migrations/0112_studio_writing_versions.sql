CREATE TABLE IF NOT EXISTS studio_writing_versions (
  project_id uuid NOT NULL REFERENCES studio_writing_projects(id),
  version bigint NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL,
  content jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('created', 'manual', 'auto', 'model', 'final', 'restore')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);
