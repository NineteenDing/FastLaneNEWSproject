CREATE TABLE IF NOT EXISTS studio_writing_generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES studio_writing_projects(id),
  base_version bigint NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  job_id uuid,
  result jsonb,
  quality text CHECK (quality IN ('checked', 'needs_attention')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, base_version)
);
