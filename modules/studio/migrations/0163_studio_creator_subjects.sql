CREATE TABLE IF NOT EXISTS studio_creator_subjects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
