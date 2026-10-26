CREATE TABLE IF NOT EXISTS studio_writing_projects (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  creation_hash text NOT NULL,
  batch_id uuid NOT NULL REFERENCES studio_topic_batches(id),
  title text NOT NULL,
  instructions text NOT NULL,
  snapshot jsonb NOT NULL,
  content jsonb NOT NULL DEFAULT '{"spoken":"","production":"","notes":""}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'final')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
