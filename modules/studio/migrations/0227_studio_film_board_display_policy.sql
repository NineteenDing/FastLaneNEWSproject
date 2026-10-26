ALTER TABLE studio_film_boards ADD COLUMN IF NOT EXISTS display_policy_version integer NOT NULL DEFAULT 0;
