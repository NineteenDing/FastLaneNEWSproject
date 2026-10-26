ALTER TABLE studio_topic_batches ADD CONSTRAINT studio_batch_root_fk FOREIGN KEY (root_batch_id) REFERENCES studio_topic_batches(id) NOT VALID;
