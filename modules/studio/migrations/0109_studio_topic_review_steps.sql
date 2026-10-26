CREATE TABLE IF NOT EXISTS studio_topic_review_steps (
  batch_id uuid NOT NULL REFERENCES studio_topic_reviews(batch_id),
  step text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  PRIMARY KEY (batch_id, step)
);
