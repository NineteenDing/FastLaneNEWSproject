CREATE TABLE IF NOT EXISTS module_queue_execution_leases (
  group_name text PRIMARY KEY,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
