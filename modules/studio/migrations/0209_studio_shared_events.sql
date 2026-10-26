CREATE TABLE IF NOT EXISTS studio_shared_events (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  label text NOT NULL,
  terms text[] NOT NULL,
  evidence jsonb NOT NULL,
  parent_id uuid REFERENCES studio_shared_events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
