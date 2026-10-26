ALTER TABLE studio_writing_images ADD CONSTRAINT studio_writing_images_asset_fk FOREIGN KEY (image_id) REFERENCES studio_image_assets(id) ON DELETE CASCADE NOT VALID;
