CREATE TABLE IF NOT EXISTS studio_image_references (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  image_id text NOT NULL REFERENCES studio_image_assets(id),
  PRIMARY KEY (owner, image_id)
);
