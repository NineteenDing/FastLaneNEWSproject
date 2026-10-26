ALTER TABLE studio_history_index ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'news';
