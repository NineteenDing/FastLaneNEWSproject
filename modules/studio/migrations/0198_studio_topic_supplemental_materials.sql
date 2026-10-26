ALTER TABLE studio_topic_batches ADD COLUMN IF NOT EXISTS supplemental_materials jsonb NOT NULL DEFAULT '[]'::jsonb;
