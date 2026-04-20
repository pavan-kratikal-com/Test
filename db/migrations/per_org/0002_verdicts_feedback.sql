-- Verdict store + feedback labels (PRD §10 feedback API, §8.3 retention).

CREATE TABLE IF NOT EXISTS verdicts (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    message_id      VARCHAR(255) NOT NULL,
    sender          VARCHAR(320) NOT NULL,
    recipient       VARCHAR(320) NOT NULL,
    verdict         VARCHAR(16)  NOT NULL,
    label           VARCHAR(32)  NOT NULL,
    confidence      FLOAT        NOT NULL,
    threat_score    FLOAT        NOT NULL,
    reason          TEXT         NOT NULL,
    signals         JSON         NULL,
    pipeline        JSON         NULL,
    fast_path_ms    FLOAT        NULL,
    deep_path_ms    FLOAT        NULL,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_verdicts_org_msg (org_id, message_id),
    INDEX ix_verdicts_org_created (org_id, created_at),
    INDEX ix_verdicts_org_label (org_id, label, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feedback_labels (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    message_id      VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    source          VARCHAR(32)  NOT NULL DEFAULT 'user',
    notes           TEXT         NULL,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX ix_feedback_org_msg (org_id, message_id),
    INDEX ix_feedback_org_created (org_id, created_at)
) ENGINE=InnoDB;
