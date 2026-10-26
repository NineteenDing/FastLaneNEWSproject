CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_writing_revisions_project_idx ON studio_writing_revisions (project_id, created_at DESC, id);
