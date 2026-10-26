ALTER TABLE studio_topic_material_analyses ADD CONSTRAINT studio_analysis_batch_fk FOREIGN KEY (batch_id) REFERENCES studio_topic_batches(id) NOT VALID;
