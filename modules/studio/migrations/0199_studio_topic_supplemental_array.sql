ALTER TABLE studio_topic_batches ADD CONSTRAINT studio_topic_supplemental_array CHECK (jsonb_typeof(supplemental_materials) = 'array') NOT VALID;
