CREATE TABLE IF NOT EXISTS studio_creator_works (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
