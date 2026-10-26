ALTER TABLE studio_creator_collection ADD COLUMN IF NOT EXISTS next_cursor text NOT NULL DEFAULT '';
