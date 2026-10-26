CREATE TABLE IF NOT EXISTS studio_trend_observations (
  id bigserial PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES studio_trend_signals(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  rank integer NOT NULL CHECK (rank > 0),
  raw_heat text,
  metrics jsonb NOT NULL
);
