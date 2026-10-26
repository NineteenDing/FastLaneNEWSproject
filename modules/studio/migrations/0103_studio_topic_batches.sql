CREATE TABLE IF NOT EXISTS studio_topic_batches (
  id uuid PRIMARY KEY,
  starts_at timestamptz NOT NULL UNIQUE,
  ends_at timestamptz NOT NULL,
  frozen_at timestamptz NOT NULL,
  audience text NOT NULL,
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  CHECK (ends_at = starts_at + interval '48 hours')
);
