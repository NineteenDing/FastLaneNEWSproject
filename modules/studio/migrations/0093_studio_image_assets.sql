CREATE TABLE IF NOT EXISTS studio_image_assets (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  storage_root text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  state text NOT NULL CHECK (state IN ('staging', 'ready')),
  touched_at timestamptz NOT NULL DEFAULT now()
);
