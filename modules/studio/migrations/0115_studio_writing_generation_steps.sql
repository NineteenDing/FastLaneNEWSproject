CREATE TABLE IF NOT EXISTS studio_writing_generation_steps (
  generation_id uuid NOT NULL REFERENCES studio_writing_generations(id),
  step text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  PRIMARY KEY (generation_id, step)
);
