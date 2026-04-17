#!/usr/bin/env node
// Applies migrations for the multi-tenant ETDP database layout.
//
//   db/migrations/shared/*.sql     -> applied once to etdp_shared
//   db/migrations/per_org/*.sql    -> applied to each org DB (etdp_org_<id>)
//
// Env:
//   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD (admin user)
//   MYSQL_SOCKET  (optional — local socket path)
//   MYSQL_SHARED_DB   default etdp_shared
//   MYSQL_ORG_PREFIX  default etdp_org_
//
// CLI:
//   node bin/migrate.js                 # shared only (idempotent)
//   node bin/migrate.js --org <org_id>  # provision + migrate one org DB
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || join(ROOT, "db", "migrations");
const SHARED_DB = process.env.MYSQL_SHARED_DB || "etdp_shared";
const ORG_PREFIX = process.env.MYSQL_ORG_PREFIX || "etdp_org_";

const argv = process.argv.slice(2);
const orgIdx = argv.indexOf("--org");
const targetOrg = orgIdx >= 0 ? argv[orgIdx + 1] : null;

function orgDbName(orgId) {
  const safe = orgId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return `${ORG_PREFIX}${safe}`;
}

function baseConnOpts(overrides = {}) {
  return {
    host: process.env.MYSQL_HOST || "mysql",
    port: Number(process.env.MYSQL_PORT || 3306),
    socketPath: process.env.MYSQL_SOCKET || undefined,
    user: process.env.MYSQL_USER || "etdp",
    password: process.env.MYSQL_PASSWORD || "etdp",
    multipleStatements: true,
    ...overrides,
  };
}

async function ensureDatabase(connNoDb, dbName) {
  await connNoDb.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
}

async function applyDir(conn, dir, scope) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);
  const [rows] = await conn.query("SELECT filename FROM _migrations");
  const applied = new Set(rows.map((r) => r.filename));
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(); }
  catch { /* dir missing */ }
  for (const file of files) {
    if (applied.has(file)) { console.log(`[${scope}] skip  ${file}`); continue; }
    const sql = readFileSync(join(dir, file), "utf8");
    await conn.query(sql);
    await conn.query("INSERT INTO _migrations (filename) VALUES (?)", [file]);
    console.log(`[${scope}] apply ${file}`);
  }
}

// ── Shared DB migrate ────────────────────────────────────────────────────
{
  const bootstrap = await mysql.createConnection(baseConnOpts());
  await ensureDatabase(bootstrap, SHARED_DB);
  await bootstrap.end();
  const conn = await mysql.createConnection(baseConnOpts({ database: SHARED_DB }));
  await applyDir(conn, join(MIGRATIONS_DIR, "shared"), "shared");
  await conn.end();
}

// ── Per-org DB migrate ───────────────────────────────────────────────────
async function migrateOrg(orgId) {
  const dbName = orgDbName(orgId);
  const bootstrap = await mysql.createConnection(baseConnOpts());
  await ensureDatabase(bootstrap, dbName);
  await bootstrap.end();

  const conn = await mysql.createConnection(baseConnOpts({ database: dbName }));
  await applyDir(conn, join(MIGRATIONS_DIR, "per_org"), `org:${orgId}`);
  await conn.end();

  // Register the provisioning in the shared DB.
  const shared = await mysql.createConnection(baseConnOpts({ database: SHARED_DB }));
  await shared.query(
    `INSERT INTO org_databases (org_id, db_name, migrations_at)
     VALUES (?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE migrations_at = NOW(3)`,
    [orgId, dbName],
  );
  await shared.end();
}

if (targetOrg) {
  await migrateOrg(targetOrg);
} else {
  // On bulk run, provision every known org.
  const shared = await mysql.createConnection(baseConnOpts({ database: SHARED_DB }));
  const [orgs] = await shared.query("SELECT org_id FROM orgs WHERE status='active'");
  await shared.end();
  for (const row of orgs) {
    await migrateOrg(row.org_id);
  }
}

console.log("[migrate] done");
