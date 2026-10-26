CREATE TABLE IF NOT EXISTS studio_shared_event_members (
  material_id text NOT NULL REFERENCES studio_history_index(material_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  event_id uuid NOT NULL REFERENCES studio_shared_events(id),
  analysis_key text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, source_key)
);
