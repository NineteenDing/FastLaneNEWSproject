CREATE TABLE IF NOT EXISTS studio_writing_revisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES studio_writing_projects(id),
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  draft jsonb,
  result jsonb,
  applied boolean NOT NULL DEFAULT false,
  error text,
  run_token uuid NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
