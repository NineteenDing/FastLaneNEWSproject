CREATE TABLE IF NOT EXISTS studio_creator_subject_accounts (
  account_id uuid PRIMARY KEY REFERENCES studio_creator_accounts(id),
  subject_id uuid NOT NULL REFERENCES studio_creator_subjects(id)
);
