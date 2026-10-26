ALTER TABLE studio_topic_material_analyses ADD CONSTRAINT studio_analysis_material_fk FOREIGN KEY (material_id) REFERENCES studio_topic_batch_materials(material_id) NOT VALID;
