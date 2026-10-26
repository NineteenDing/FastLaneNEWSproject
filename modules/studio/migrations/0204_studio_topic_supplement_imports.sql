CREATE TABLE IF NOT EXISTS studio_topic_supplement_imports (
  id uuid PRIMARY KEY,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  column_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('news', 'creator')),
  identity_key text NOT NULL,
  url text NOT NULL,
  import_id uuid,
  material_id text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'reading', 'waiting_transcript', 'waiting_cutoff', 'applied', 'failed')),
  retry_import boolean NOT NULL DEFAULT false,
  result_batch_id uuid REFERENCES studio_topic_batches(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (starts_at, column_id, kind, identity_key)
);
