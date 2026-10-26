CREATE TABLE IF NOT EXISTS studio_media_transcripts (
  post_id uuid PRIMARY KEY REFERENCES studio_creator_posts(id),
  source_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  workspace_id uuid,
  saved_at timestamptz NOT NULL DEFAULT now()
);
