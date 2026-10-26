CREATE TABLE IF NOT EXISTS studio_trend_event_links (
  signal_id uuid NOT NULL REFERENCES studio_trend_signals(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES studio_shared_events(id),
  material_id text NOT NULL,
  source_key text NOT NULL,
  method text NOT NULL CHECK (method IN ('exact_headline', 'collected_material')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, event_id, material_id, source_key)
);
