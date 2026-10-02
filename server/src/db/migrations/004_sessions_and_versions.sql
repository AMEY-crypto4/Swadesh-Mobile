ALTER TABLE users ADD COLUMN is_shared_demo TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN is_session TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN last_seen_at DATETIME(3) NULL;

ALTER TABLE users ADD INDEX idx_users_session (company_id, is_session, status, last_seen_at);

ALTER TABLE queues ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1;

ALTER TABLE campaigns ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1;
