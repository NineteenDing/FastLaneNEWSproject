CREATE TABLE IF NOT EXISTS studio_film_translations (text_key text PRIMARY KEY, title_zh text NOT NULL, summary_zh text, created_at timestamptz NOT NULL DEFAULT now());
