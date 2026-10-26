CREATE TABLE IF NOT EXISTS studio_creator_aliases (
  platform text NOT NULL,
  locator text NOT NULL CHECK (length(locator) BETWEEN 1 AND 200),
  creator_id uuid NOT NULL REFERENCES studio_creator_accounts(id),
  PRIMARY KEY (platform, locator)
);
