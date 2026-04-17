-- Phase 1 completion: org registry, industry priors, cold-start baselines,
-- per-signal weight tracking, and feedback/label indexing.

CREATE TABLE IF NOT EXISTS orgs (
    org_id                VARCHAR(64)  NOT NULL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,
    industry              VARCHAR(64)  NOT NULL DEFAULT 'general',
    timezone              VARCHAR(64)  NOT NULL DEFAULT 'UTC',
    business_hours_start  TINYINT      NOT NULL DEFAULT 8,
    business_hours_end    TINYINT      NOT NULL DEFAULT 20,
    thresholds            JSON         NOT NULL,
    onboarded_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    status                VARCHAR(16)  NOT NULL DEFAULT 'active'
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS industry_priors (
    industry              VARCHAR(64)  NOT NULL PRIMARY KEY,
    bec_weight            FLOAT        NOT NULL DEFAULT 1.0,
    phishing_weight       FLOAT        NOT NULL DEFAULT 1.0,
    malware_weight        FLOAT        NOT NULL DEFAULT 1.0,
    notes                 VARCHAR(255) NULL
) ENGINE=InnoDB;

INSERT IGNORE INTO industry_priors (industry, bec_weight, phishing_weight, malware_weight, notes) VALUES
    ('banking',    1.5, 1.3, 1.2, 'High BEC risk; regulated'),
    ('tech',       1.0, 1.0, 1.0, 'Standard'),
    ('government', 1.3, 1.3, 1.4, 'APT target'),
    ('healthcare', 1.2, 1.3, 1.3, 'HIPAA data sensitivity'),
    ('legal',      1.4, 1.2, 1.0, 'High-value BEC target'),
    ('retail',     1.0, 1.2, 1.1, 'Payment fraud exposure'),
    ('general',    1.0, 1.0, 1.0, 'Default prior');

-- Global baselines used during org cold-start (first 30 days).
CREATE TABLE IF NOT EXISTS global_baselines (
    metric                VARCHAR(64)  NOT NULL PRIMARY KEY,
    value                 DOUBLE       NOT NULL,
    updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

INSERT IGNORE INTO global_baselines (metric, value) VALUES
    ('avg_sender_daily_count', 3.5),
    ('avg_sender_hourly_count', 0.2),
    ('avg_attachment_rate',    0.08),
    ('avg_link_count',          1.2),
    ('avg_recipient_count',     2.0);

-- Track weight ramp (0 → 1 over 30 days for Stats DB, 60 for Graph DB).
CREATE TABLE IF NOT EXISTS org_signal_ramp (
    org_id        VARCHAR(64) NOT NULL,
    source        VARCHAR(32) NOT NULL,   -- 'stats_db' | 'graph_db'
    started_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ramp_days     INT         NOT NULL,
    PRIMARY KEY (org_id, source)
) ENGINE=InnoDB;

-- Index used by the feedback → retrain accumulator (PRD §9.3).
CREATE INDEX ix_feedback_for_retrain
    ON feedback_labels (org_id, created_at);

-- Seed a demo org so scaffold runs work out of the box.
INSERT IGNORE INTO orgs (org_id, name, industry, thresholds) VALUES
    ('org_demo_001', 'Demo Org', 'general', JSON_OBJECT('block', 10, 'quarantine', 5));
