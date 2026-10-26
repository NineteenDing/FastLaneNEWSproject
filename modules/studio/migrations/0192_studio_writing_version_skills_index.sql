CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_writing_version_skills_idx ON studio_writing_versions (project_id, version DESC) WHERE skills IS NOT NULL;
