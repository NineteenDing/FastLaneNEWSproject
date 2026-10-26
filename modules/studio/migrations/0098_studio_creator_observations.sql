CREATE TABLE IF NOT EXISTS studio_creator_observations (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES studio_creator_posts(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL
);
