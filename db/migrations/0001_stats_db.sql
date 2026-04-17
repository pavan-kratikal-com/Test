-- Stats DB schema (PRD §7.3) — MySQL 8 dialect.
-- Schema-per-tenant in production; this file creates the canonical table set
-- in the default database for the scaffold.

CREATE TABLE IF NOT EXISTS email_metadata (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    org_id            VARCHAR(64)  NOT NULL,
    message_id        VARCHAR(255) NOT NULL,
    sender            VARCHAR(320) NOT NULL,
    sender_domain     VARCHAR(255) NOT NULL,
    recipient         VARCHAR(320) NOT NULL,
    `timestamp`       DATETIME(3)  NOT NULL,
    size_bytes        INT UNSIGNED NOT NULL,
    has_attachment    TINYINT(1)   NOT NULL DEFAULT 0,
    attachment_count  INT UNSIGNED NOT NULL DEFAULT 0,
    attachment_types  JSON         NULL,
    subject_length    INT UNSIGNED NOT NULL DEFAULT 0,
    body_length       INT UNSIGNED NOT NULL DEFAULT 0,
    link_count        INT UNSIGNED NOT NULL DEFAULT 0,
    slm_label         VARCHAR(32)  NULL,
    slm_confidence    FLOAT        NULL,
    created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX ix_email_metadata_org_sender (org_id, sender, `timestamp`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sender_daily_stats (
    org_id              VARCHAR(64)  NOT NULL,
    sender              VARCHAR(320) NOT NULL,
    `date`              DATE         NOT NULL,
    email_count         INT UNSIGNED NOT NULL DEFAULT 0,
    avg_size            DOUBLE       NULL,
    attachment_rate     DOUBLE       NULL,
    unique_recipients   INT UNSIGNED NOT NULL DEFAULT 0,
    avg_confidence      DOUBLE       NULL,
    label_distribution  JSON         NULL,
    PRIMARY KEY (org_id, sender, `date`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sender_recipient_pairs (
    org_id                VARCHAR(64)  NOT NULL,
    sender                VARCHAR(320) NOT NULL,
    recipient             VARCHAR(320) NOT NULL,
    total_count           INT UNSIGNED NOT NULL DEFAULT 0,
    last_seen             DATETIME(3)  NULL,
    avg_reply_time_hours  DOUBLE       NULL,
    direction_ratio       DOUBLE       NULL,
    first_seen            DATETIME(3)  NULL,
    PRIMARY KEY (org_id, sender, recipient)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS domain_first_seen (
    org_id              VARCHAR(64)  NOT NULL,
    domain              VARCHAR(255) NOT NULL,
    first_seen          DATETIME(3)  NOT NULL,
    total_emails_from   INT UNSIGNED NOT NULL DEFAULT 0,
    is_freemail         TINYINT(1)   NOT NULL DEFAULT 0,
    avg_threat_score    DOUBLE       NULL,
    PRIMARY KEY (org_id, domain)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS hourly_distribution (
    org_id        VARCHAR(64)  NOT NULL,
    sender        VARCHAR(320) NOT NULL,
    hour_of_day   TINYINT UNSIGNED NOT NULL,
    day_of_week   TINYINT UNSIGNED NOT NULL,
    email_count   INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, sender, hour_of_day, day_of_week),
    CHECK (hour_of_day < 24),
    CHECK (day_of_week < 7)
) ENGINE=InnoDB;
