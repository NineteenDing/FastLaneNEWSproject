CREATE TABLE IF NOT EXISTS studio_topic_supplement_windows (
  starts_at timestamptz PRIMARY KEY,
  ends_at timestamptz NOT NULL,
  materials jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(materials) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  submitted_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
