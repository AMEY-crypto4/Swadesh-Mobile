CREATE TABLE api_keys (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  prefix VARCHAR(24) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  scopes JSON NOT NULL,
  rate_limit_per_min SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_keys_company (company_id, revoked_at)
);

CREATE TABLE webhooks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  url VARCHAR(400) NOT NULL,
  secret VARCHAR(80) NOT NULL,
  events JSON NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_webhooks_company (company_id, active)
);

CREATE TABLE webhook_deliveries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  webhook_id INT UNSIGNED NOT NULL,
  event VARCHAR(40) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  response_code SMALLINT NULL,
  last_error VARCHAR(200) NULL,
  next_attempt_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_deliv_company (company_id, created_at),
  INDEX idx_deliv_due (status, next_attempt_at)
);
