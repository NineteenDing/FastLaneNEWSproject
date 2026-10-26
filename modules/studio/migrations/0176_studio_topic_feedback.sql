CREATE TABLE IF NOT EXISTS studio_topic_feedback (
  batch_id uuid NOT NULL REFERENCES studio_topic_batches(id),
  direction_id text NOT NULL CHECK (length(direction_id) BETWEEN 1 AND 80),
  version integer NOT NULL CHECK (version > 0),
  rating text CHECK (rating IN ('useful', 'not_useful')),
  reason text NOT NULL CHECK (length(reason) <= 1000),
  direction jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, direction_id)
);
