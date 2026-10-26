CREATE TABLE IF NOT EXISTS studio_news_titles (
  text_key text PRIMARY KEY,
  title_zh text NOT NULL,
  receipt_id bigint REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
