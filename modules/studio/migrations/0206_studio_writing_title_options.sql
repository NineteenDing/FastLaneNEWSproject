ALTER TABLE studio_writing_projects ADD COLUMN IF NOT EXISTS title_options jsonb NOT NULL DEFAULT '[]'::jsonb;
