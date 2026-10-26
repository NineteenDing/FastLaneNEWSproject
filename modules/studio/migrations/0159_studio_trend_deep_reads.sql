CREATE TABLE IF NOT EXISTS studio_trend_deep_reads (
  signal_id uuid NOT NULL REFERENCES studio_trend_signals(id),
  relevance_key text NOT NULL,
  import_id uuid NOT NULL REFERENCES studio_content_imports(id),
  signal_snapshot jsonb NOT NULL,
  budget_day date NOT NULL,
  charged boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, relevance_key)
);
