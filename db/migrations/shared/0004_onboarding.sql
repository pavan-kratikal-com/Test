-- 0004_onboarding.sql
-- Multi-domain mapping, OAuth connectors, integration type for customer self-onboarding

-- org_domains: maps multiple domains to one org, with DNS verification
CREATE TABLE IF NOT EXISTS org_domains (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id        VARCHAR(64)  NOT NULL,
  domain        VARCHAR(255) NOT NULL,
  verified      TINYINT(1)   NOT NULL DEFAULT 0,
  verify_token  VARCHAR(64)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_domain (domain),
  INDEX idx_org (org_id),
  CONSTRAINT fk_org_domains_org FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- oauth_connectors: stores OAuth tokens per org/provider
CREATE TABLE IF NOT EXISTS oauth_connectors (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  org_id          VARCHAR(64)  NOT NULL,
  provider        VARCHAR(16)  NOT NULL COMMENT 'google or microsoft',
  access_token    TEXT         NULL,
  refresh_token   TEXT         NULL,
  token_expires   DATETIME(3)  NULL,
  scopes          VARCHAR(512) NULL,
  tenant_id       VARCHAR(128) NULL COMMENT 'Microsoft tenant ID if applicable',
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending, connected, error, revoked',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_org_provider (org_id, provider),
  CONSTRAINT fk_oauth_org FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add integration_type to orgs
ALTER TABLE orgs
  ADD COLUMN integration_type VARCHAR(24) NOT NULL DEFAULT 'none'
  COMMENT 'smtp_relay, oauth_google, oauth_microsoft, none';
