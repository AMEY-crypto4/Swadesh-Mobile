CREATE TABLE companies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(60) NOT NULL UNIQUE,
  plan ENUM('starter','growth','enterprise') NOT NULL DEFAULT 'growth',
  tz_offset_minutes SMALLINT NOT NULL DEFAULT 330,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','supervisor','agent') NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  extension VARCHAR(8) NULL,
  skills JSON NULL,
  is_bot TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_users_company_role (company_id, role, status),
  CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE queues (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  strategy ENUM('round_robin','longest_idle','least_calls','skills_based','ring_all') NOT NULL DEFAULT 'longest_idle',
  sla_seconds SMALLINT NOT NULL DEFAULT 20,
  max_wait_seconds SMALLINT NOT NULL DEFAULT 90,
  wrap_up_seconds SMALLINT NOT NULL DEFAULT 20,
  required_skill VARCHAR(40) NULL,
  recording_consent_mode ENUM('none','announce','opt_in') NOT NULL DEFAULT 'announce',
  inbound_rate_per_min DECIMAL(5,2) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_queue_name (company_id, name),
  CONSTRAINT fk_queues_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE queue_members (
  company_id INT UNSIGNED NOT NULL,
  queue_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  priority TINYINT NOT NULL DEFAULT 1,
  PRIMARY KEY (queue_id, user_id),
  INDEX idx_qm_company_user (company_id, user_id),
  CONSTRAINT fk_qm_queue FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE,
  CONSTRAINT fk_qm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE campaigns (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  queue_id INT UNSIGNED NOT NULL,
  mode ENUM('preview','progressive','predictive') NOT NULL DEFAULT 'progressive',
  status ENUM('draft','running','paused','completed') NOT NULL DEFAULT 'draft',
  pacing_ratio DECIMAL(3,1) NOT NULL DEFAULT 1.5,
  max_abandon_pct DECIMAL(4,1) NOT NULL DEFAULT 3.0,
  max_attempts TINYINT NOT NULL DEFAULT 3,
  retry_delay_minutes SMALLINT NOT NULL DEFAULT 30,
  call_window_start TIME NOT NULL DEFAULT '09:00:00',
  call_window_end TIME NOT NULL DEFAULT '20:00:00',
  caller_id VARCHAR(20) NOT NULL,
  ring_timeout_secs TINYINT UNSIGNED NOT NULL DEFAULT 25,
  dnc_check TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_campaign_company_status (company_id, status),
  CONSTRAINT fk_campaign_queue FOREIGN KEY (queue_id) REFERENCES queues(id)
);

CREATE TABLE dialer_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  priority TINYINT NOT NULL DEFAULT 1,
  outcome VARCHAR(30) NOT NULL,
  action ENUM('retry_after','mark_done','schedule_callback','add_to_dnc') NOT NULL,
  action_param INT NULL,
  INDEX idx_rules_campaign (company_id, campaign_id, priority),
  CONSTRAINT fk_rules_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE leads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(160) NULL,
  status ENUM('new','dialing','callback','contacted','done','dnc','exhausted') NOT NULL DEFAULT 'new',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  priority TINYINT NOT NULL DEFAULT 5,
  last_outcome VARCHAR(30) NULL,
  last_attempt_at DATETIME(3) NULL,
  next_attempt_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_lead_phone (company_id, campaign_id, phone),
  INDEX idx_leads_dial (company_id, campaign_id, status, next_attempt_at, priority),
  INDEX idx_leads_phone (company_id, phone),
  CONSTRAINT fk_leads_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE dnc_numbers (
  company_id INT UNSIGNED NOT NULL,
  phone VARCHAR(20) NOT NULL,
  reason VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, phone)
);

CREATE TABLE dispositions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  code VARCHAR(30) NOT NULL,
  label VARCHAR(80) NOT NULL,
  category ENUM('positive','neutral','negative') NOT NULL,
  UNIQUE KEY uq_disp (company_id, code)
);

CREATE TABLE calls (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  direction ENUM('inbound','outbound') NOT NULL,
  campaign_id INT UNSIGNED NULL,
  queue_id INT UNSIGNED NULL,
  lead_id BIGINT UNSIGNED NULL,
  agent_id INT UNSIGNED NULL,
  from_number VARCHAR(20) NULL,
  to_number VARCHAR(20) NULL,
  status ENUM('queued','ringing','in_progress','completed','abandoned','no_answer','busy','voicemail','failed') NOT NULL,
  disposition VARCHAR(30) NULL,
  notes VARCHAR(500) NULL,
  started_at DATETIME(3) NOT NULL,
  answered_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  wait_secs SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  talk_secs INT UNSIGNED NOT NULL DEFAULT 0,
  wrap_secs SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  recording_consent ENUM('not_required','announced','granted','declined') NOT NULL DEFAULT 'not_required',
  recording_state ENUM('none','recording','paused','stopped','purged') NOT NULL DEFAULT 'none',
  recording_key VARCHAR(120) NULL,
  INDEX idx_calls_started (company_id, started_at),
  INDEX idx_calls_queue (company_id, queue_id, started_at),
  INDEX idx_calls_agent (company_id, agent_id, started_at),
  INDEX idx_calls_campaign (company_id, campaign_id, started_at),
  INDEX idx_calls_status (company_id, status, started_at),
  INDEX idx_calls_to (company_id, to_number),
  INDEX idx_calls_from (company_id, from_number)
);

CREATE TABLE sms_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  api_key_id INT UNSIGNED NULL,
  direction ENUM('inbound','outbound') NOT NULL DEFAULT 'outbound',
  from_number VARCHAR(20) NOT NULL,
  to_number VARCHAR(20) NOT NULL,
  body VARCHAR(1600) NOT NULL,
  segments TINYINT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('queued','sent','delivered','failed') NOT NULL DEFAULT 'queued',
  error VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_sms_company_created (company_id, created_at),
  INDEX idx_sms_to (company_id, to_number)
);
