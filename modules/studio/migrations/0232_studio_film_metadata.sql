CREATE TABLE IF NOT EXISTS studio_film_metadata (
  cache_key text PRIMARY KEY,
  payload jsonb,
  state text NOT NULL CHECK (state IN ('queued','ready','failed')),
  run_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
