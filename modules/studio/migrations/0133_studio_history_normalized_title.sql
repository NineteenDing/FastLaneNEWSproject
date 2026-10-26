ALTER TABLE studio_history_index ADD COLUMN IF NOT EXISTS normalized_title text NOT NULL DEFAULT '';
