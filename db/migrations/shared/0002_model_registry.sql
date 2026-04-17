-- Per-org model registry + training jobs + A/B deployments + URL scan cache.
-- PRD §9.2 (model lifecycle), §9.4 (versioning + rollback).

CREATE TABLE IF NOT EXISTS org_models (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    version         VARCHAR(32)  NOT NULL,
    model_kind      VARCHAR(32)  NOT NULL DEFAULT 'logistic',  -- logistic | slm_adapter
    weights         JSON         NOT NULL,
    intercept       FLOAT        NOT NULL DEFAULT 0,
    feature_names   JSON         NOT NULL,
    val_accuracy    FLOAT        NULL,
    val_precision   FLOAT        NULL,
    val_recall      FLOAT        NULL,
    val_fp_rate     FLOAT        NULL,
    trained_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    trained_on      INT UNSIGNED NOT NULL DEFAULT 0,
    status          VARCHAR(16)  NOT NULL DEFAULT 'trained',   -- trained | active | retired | rolled_back
    parent_version  VARCHAR(32)  NULL,
    UNIQUE KEY uq_org_models_ver (org_id, version),
    INDEX ix_org_models_status (org_id, status)
) ENGINE=InnoDB;

-- Active deployments include the incumbent and (optionally) a canary slice.
CREATE TABLE IF NOT EXISTS model_deployments (
    org_id          VARCHAR(64)  NOT NULL,
    role            VARCHAR(16)  NOT NULL,   -- 'incumbent' | 'canary'
    model_version   VARCHAR(32)  NOT NULL,
    traffic_pct     SMALLINT UNSIGNED NOT NULL DEFAULT 100,
    deployed_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, role)
) ENGINE=InnoDB;

-- Training jobs: audit trail of every train run.
CREATE TABLE IF NOT EXISTS training_jobs (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    started_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at     DATETIME(3)  NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'running',   -- running | success | failed | rolled_back
    labels_used     INT UNSIGNED NOT NULL DEFAULT 0,
    resulting_version VARCHAR(32) NULL,
    notes           TEXT         NULL,
    INDEX ix_training_jobs_org (org_id, started_at)
) ENGINE=InnoDB;

-- URL scanner cache (24hr TTL). Shared across all orgs.
CREATE TABLE IF NOT EXISTS url_scan_cache (
    url_hash        CHAR(64)     NOT NULL PRIMARY KEY,  -- sha256 of URL
    url             VARCHAR(2048) NOT NULL,
    final_url       VARCHAR(2048) NULL,
    redirect_hops   SMALLINT     NOT NULL DEFAULT 0,
    final_status    SMALLINT     NULL,
    risk_score      FLOAT        NOT NULL DEFAULT 0,
    signals         JSON         NOT NULL,
    scanned_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX ix_url_scan_cache_scanned (scanned_at)
) ENGINE=InnoDB;
