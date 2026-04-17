-- E4 Graph DB — per-org communication graph (PRD §7.4).
-- Phase 2 uses MySQL edge tables; Neo4j/AGE is a Phase 3+ upgrade.

CREATE TABLE IF NOT EXISTS graph_nodes (
    org_id          VARCHAR(64)  NOT NULL,
    address         VARCHAR(320) NOT NULL,
    display_name    VARCHAR(255) NULL,
    is_internal     TINYINT(1)   NOT NULL DEFAULT 0,
    department      VARCHAR(128) NULL,
    title           VARCHAR(128) NULL,
    first_seen      DATETIME(3)  NOT NULL,
    last_seen       DATETIME(3)  NOT NULL,
    total_sent      INT UNSIGNED NOT NULL DEFAULT 0,
    total_received  INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, address)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS graph_edges (
    org_id          VARCHAR(64)  NOT NULL,
    src             VARCHAR(320) NOT NULL,
    dst             VARCHAR(320) NOT NULL,
    count           INT UNSIGNED NOT NULL DEFAULT 0,
    first_seen      DATETIME(3)  NOT NULL,
    last_seen       DATETIME(3)  NOT NULL,
    PRIMARY KEY (org_id, src, dst),
    INDEX ix_graph_edges_dst (org_id, dst),
    INDEX ix_graph_edges_recent (org_id, last_seen)
) ENGINE=InnoDB;

-- Precomputed trust scores (refreshed nightly or on-demand).
CREATE TABLE IF NOT EXISTS graph_trust (
    org_id                  VARCHAR(64)  NOT NULL,
    address                 VARCHAR(320) NOT NULL,
    trust_score             FLOAT        NOT NULL DEFAULT 0,
    reply_reciprocity       FLOAT        NOT NULL DEFAULT 0,
    relationship_age_days   INT          NOT NULL DEFAULT 0,
    updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (org_id, address)
) ENGINE=InnoDB;

-- Display-name collision index (for VIP/exec impersonation detection).
-- Populated from LDAP/AD import; falls back to learned display names.
CREATE TABLE IF NOT EXISTS graph_display_names (
    org_id            VARCHAR(64)  NOT NULL,
    normalized_name   VARCHAR(255) NOT NULL,
    canonical_address VARCHAR(320) NOT NULL,
    is_vip            TINYINT(1)   NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, normalized_name)
) ENGINE=InnoDB;
