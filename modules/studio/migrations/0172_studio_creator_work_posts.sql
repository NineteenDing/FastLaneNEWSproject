CREATE TABLE IF NOT EXISTS studio_creator_work_posts (
  post_id uuid PRIMARY KEY REFERENCES studio_creator_posts(id),
  work_id uuid NOT NULL REFERENCES studio_creator_works(id)
);
