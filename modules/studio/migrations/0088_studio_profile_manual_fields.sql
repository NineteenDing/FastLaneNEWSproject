ALTER TABLE studio_news_profiles ADD COLUMN manual_fields text[] NOT NULL DEFAULT '{description,region,language,homepage}'::text[];
