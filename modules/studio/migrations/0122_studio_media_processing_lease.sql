CREATE TABLE IF NOT EXISTS studio_media_processing_lease (
  id integer PRIMARY KEY CHECK (id = 1),
  token uuid NOT NULL,
  task text NOT NULL,
  expires_at timestamptz NOT NULL
);
