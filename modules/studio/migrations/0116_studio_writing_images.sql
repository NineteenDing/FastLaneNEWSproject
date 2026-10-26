CREATE TABLE IF NOT EXISTS studio_writing_images (
  project_id uuid NOT NULL REFERENCES studio_writing_projects(id),
  image_id text NOT NULL REFERENCES studio_image_assets(id),
  name text NOT NULL,
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, image_id)
);
