CREATE TABLE IF NOT EXISTS studio_topic_column_versions (
  column_id text NOT NULL CHECK (length(column_id) BETWEEN 1 AND 80),
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  PRIMARY KEY (column_id, version)
);
