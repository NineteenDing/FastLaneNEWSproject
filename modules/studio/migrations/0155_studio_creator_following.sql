ALTER TABLE studio_creator_accounts ADD COLUMN IF NOT EXISTS following boolean NOT NULL DEFAULT true;
