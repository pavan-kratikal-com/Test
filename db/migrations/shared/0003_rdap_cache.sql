CREATE TABLE IF NOT EXISTS domain_rdap_cache (
    domain              VARCHAR(255) NOT NULL PRIMARY KEY,
    registration_date   DATETIME(3)  NULL,
    expiration_date     DATETIME(3)  NULL,
    registrar           VARCHAR(255) NULL,
    rdap_status         VARCHAR(32)  NOT NULL DEFAULT 'ok',
    rdap_raw            JSON         NULL,
    queried_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX ix_rdap_queried (queried_at)
) ENGINE=InnoDB;
