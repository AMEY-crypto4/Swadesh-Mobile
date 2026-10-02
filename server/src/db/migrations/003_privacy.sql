CREATE TABLE privacy_settings (
  company_id INT UNSIGNED PRIMARY KEY,
  retention_recordings_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  retention_calls_days SMALLINT UNSIGNED NOT NULL DEFAULT 730,
  retention_sms_days SMALLINT UNSIGNED NOT NULL DEFAULT 365,
  consent_prompt_text VARCHAR(400) NOT NULL DEFAULT 'This call may be recorded for quality and training purposes.',
  allow_pause_resume TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE consent_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  call_id BIGINT UNSIGNED NULL,
  subject_phone VARCHAR(20) NULL,
  type ENUM('prompt_played','granted','declined','recording_paused','recording_resumed','recording_stopped','pause_override') NOT NULL,
  actor VARCHAR(60) NOT NULL DEFAULT 'system',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_consent_company (company_id, created_at),
  INDEX idx_consent_call (company_id, call_id),
  INDEX idx_consent_phone (company_id, subject_phone)
);

CREATE TABLE recording_pause_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  call_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  issued_to VARCHAR(60) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at DATETIME(3) NULL,
  INDEX idx_pause_call (company_id, call_id, consumed_at)
);

CREATE TABLE data_exports (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  type ENUM('calls','sms','consent','subject') NOT NULL,
  params JSON NULL,
  status ENUM('queued','running','ready','failed') NOT NULL DEFAULT 'queued',
  row_count INT UNSIGNED NULL,
  file_path VARCHAR(300) NULL,
  error VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  INDEX idx_exports_company (company_id, created_at)
);

CREATE TABLE deletion_requests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  subject_phone VARCHAR(20) NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  status ENUM('completed') NOT NULL DEFAULT 'completed',
  summary JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_del_company (company_id, created_at)
);
