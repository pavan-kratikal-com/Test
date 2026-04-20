-- Grant etdp user privilege to CREATE DATABASE (for lazy per-org provisioning).
-- In production, provisioning should use a dedicated admin role, not the
-- runtime user.
GRANT ALL PRIVILEGES ON *.* TO 'etdp'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
