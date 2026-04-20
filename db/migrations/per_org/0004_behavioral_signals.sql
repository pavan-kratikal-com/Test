-- Per-org schema additions for behavioral signal expansion.
-- Adds: sender fingerprint, thread tracking columns, attachment type history.

-- Sender behavioral fingerprint (for sender_style_deviation signal).
CREATE TABLE IF NOT EXISTS sender_fingerprint (
    org_id              VARCHAR(64)  NOT NULL,
    sender              VARCHAR(320) NOT NULL,
    sample_count        INT UNSIGNED NOT NULL DEFAULT 0,
    avg_body_length     DOUBLE       NOT NULL DEFAULT 0,
    stddev_body_length  DOUBLE       NOT NULL DEFAULT 0,
    avg_subject_length  DOUBLE       NOT NULL DEFAULT 0,
    html_ratio          DOUBLE       NOT NULL DEFAULT 0,
    avg_link_count      DOUBLE       NOT NULL DEFAULT 0,
    avg_attachment_count DOUBLE      NOT NULL DEFAULT 0,
    typical_hours       BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- 24-bit bitmap
    typical_days        TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 7-bit bitmap
    avg_recipients      DOUBLE       NOT NULL DEFAULT 0,
    updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, sender)
) ENGINE=InnoDB;

-- Thread tracking: add In-Reply-To for conversation assembly.
-- MySQL 8.x doesn't support ADD COLUMN IF NOT EXISTS; use procedure workaround.
SET @db = DATABASE();
SET @tbl = 'email_metadata';

SELECT COUNT(*) INTO @col_exists
  FROM information_schema.columns
  WHERE table_schema = @db AND table_name = @tbl AND column_name = 'in_reply_to';
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE email_metadata ADD COLUMN in_reply_to VARCHAR(512) NULL',
  'SELECT 1');
PREPARE _s FROM @stmt; EXECUTE _s; DEALLOCATE PREPARE _s;

SELECT COUNT(*) INTO @col_exists
  FROM information_schema.columns
  WHERE table_schema = @db AND table_name = @tbl AND column_name = 'references_header';
SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE email_metadata ADD COLUMN references_header TEXT NULL',
  'SELECT 1');
PREPARE _s FROM @stmt; EXECUTE _s; DEALLOCATE PREPARE _s;

-- Index for fast thread lookups by message_id.
-- MySQL 8.x: check if index exists before creating.
SELECT COUNT(*) INTO @idx_exists
  FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = @tbl AND index_name = 'ix_email_metadata_msgid';
SET @stmt = IF(@idx_exists = 0,
  'CREATE INDEX ix_email_metadata_msgid ON email_metadata (org_id, message_id)',
  'SELECT 1');
PREPARE _s FROM @stmt; EXECUTE _s; DEALLOCATE PREPARE _s;

-- Per-sender attachment type history (for attachment behavioral signals).
CREATE TABLE IF NOT EXISTS sender_attachment_types (
    org_id              VARCHAR(64)  NOT NULL,
    sender              VARCHAR(320) NOT NULL,
    extension           VARCHAR(32)  NOT NULL,
    count               INT UNSIGNED NOT NULL DEFAULT 0,
    first_seen          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, sender, extension)
) ENGINE=InnoDB;

-- Per-sender URL domain history (for url_sender_url_mismatch signal).
CREATE TABLE IF NOT EXISTS sender_url_domains (
    org_id              VARCHAR(64)  NOT NULL,
    sender              VARCHAR(320) NOT NULL,
    url_domain          VARCHAR(255) NOT NULL,
    count               INT UNSIGNED NOT NULL DEFAULT 0,
    first_seen          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, sender, url_domain)
) ENGINE=InnoDB;

-- Per-sender header fingerprint (for E9 client drift signals).
CREATE TABLE IF NOT EXISTS sender_header_fingerprint (
    org_id              VARCHAR(64)  NOT NULL,
    sender              VARCHAR(320) NOT NULL,
    x_mailer            VARCHAR(255) NULL,
    header_order_hash   CHAR(16)     NULL,
    avg_received_hops   DOUBLE       NOT NULL DEFAULT 0,
    sample_count        INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, sender)
) ENGINE=InnoDB;
