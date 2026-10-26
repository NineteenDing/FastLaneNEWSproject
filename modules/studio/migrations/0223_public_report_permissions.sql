CREATE TABLE IF NOT EXISTS studio_public_reports (report_id bigint PRIMARY KEY REFERENCES reports(id), revision integer NOT NULL, approved_at timestamptz NOT NULL DEFAULT now());
