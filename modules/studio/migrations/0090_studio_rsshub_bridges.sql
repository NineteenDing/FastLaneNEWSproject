CREATE TABLE studio_rsshub_bridges (
  source_id text PRIMARY KEY REFERENCES sources(id),
  route text NOT NULL,
  item_limit integer NOT NULL,
  ai_filter boolean NOT NULL
);
