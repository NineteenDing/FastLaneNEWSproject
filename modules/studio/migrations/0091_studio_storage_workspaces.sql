CREATE TABLE studio_storage_workspaces (
  id uuid PRIMARY KEY,
  task text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('media', 'exports', 'backup')),
  bytes bigint NOT NULL CHECK (bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
