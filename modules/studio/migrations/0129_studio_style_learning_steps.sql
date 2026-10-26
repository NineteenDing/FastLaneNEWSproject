CREATE TABLE IF NOT EXISTS studio_style_learning_steps (
  learning_id uuid NOT NULL REFERENCES studio_style_learning(id),
  step text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  PRIMARY KEY (learning_id, step)
);
