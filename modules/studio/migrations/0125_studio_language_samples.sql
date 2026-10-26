CREATE TABLE IF NOT EXISTS studio_language_samples (
  project_id uuid PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  column_ids text[] NOT NULL,
  confirmed_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, version) REFERENCES studio_writing_versions(project_id, version)
);
