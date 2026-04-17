// Pooled MySQL access for the multi-tenant ETDP layout.
//
//   getSharedPool()        → pool bound to etdp_shared (orgs, priors, model registry)
//   getOrgPool(org_id)     → pool bound to etdp_org_<sanitized> (stats, verdicts, feedback)
//   safeQuery(sql, params) → shared-DB query (legacy; errors soft-fail)
//   safeOrgQuery(orgId, sql, params) → per-org query (errors soft-fail)
//
// In "multi" mode (MYSQL_MULTI_TENANT=1, the default when env is set) the
// two pools point at distinct databases. In "single" mode both resolve to
// the same database (legacy single-DB scaffold) for backward compat with
// the Phase 1 scaffold.
import mysql from "mysql2/promise";

const MULTI = process.env.MYSQL_MULTI_TENANT !== "0"; // default ON
const SHARED_DB = process.env.MYSQL_SHARED_DB || "etdp_shared";
const ORG_PREFIX = process.env.MYSQL_ORG_PREFIX || "etdp_org_";
const LEGACY_DB = process.env.MYSQL_DATABASE || "etdp";

function baseOpts(database) {
  return {
    host: process.env.MYSQL_HOST || "mysql",
    port: Number(process.env.MYSQL_PORT || 3306),
    socketPath: process.env.MYSQL_SOCKET || undefined,
    user: process.env.MYSQL_USER || "etdp",
    password: process.env.MYSQL_PASSWORD || "etdp",
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 10),
    namedPlaceholders: false,
    timezone: "Z",
  };
}

export function orgDbName(orgId) {
  const safe = orgId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return `${ORG_PREFIX}${safe}`;
}

let sharedPool = null;
const orgPools = new Map();

export function getSharedPool() {
  if (!sharedPool) {
    sharedPool = mysql.createPool(baseOpts(MULTI ? SHARED_DB : LEGACY_DB));
  }
  return sharedPool;
}

export function getOrgPool(orgId) {
  if (!MULTI) return getSharedPool();
  if (orgPools.has(orgId)) return orgPools.get(orgId);
  const pool = mysql.createPool(baseOpts(orgDbName(orgId)));
  orgPools.set(orgId, pool);
  return pool;
}

// Best-effort wrapper: never throw. Used by Phase 1 paths that prefer
// to fail open when the DB is unreachable or the per-org DB hasn't been
// provisioned yet.
export async function safeQuery(sql, params = []) {
  try {
    const [rows] = await getSharedPool().query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

export async function safeOrgQuery(orgId, sql, params = []) {
  try {
    const [rows] = await getOrgPool(orgId).query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

// Lazy provisioning: called when gateway first sees a new org_id.
// Creates the per-org DB (if user has privileges) and applies per-org migrations.
export async function provisionOrg(orgId) {
  if (!MULTI) return { ok: true, provisioned: false };
  const dbName = orgDbName(orgId);
  const admin = mysql.createPool(baseOpts(undefined)); // no DB
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  } catch (err) {
    await admin.end();
    return { ok: false, error: `cannot create DB ${dbName}: ${err.message}` };
  }
  await admin.end();

  // Apply per-org migrations inline (avoids requiring a separate job).
  const { readdirSync, readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(here, "..", "db", "migrations", "per_org");

  const conn = await mysql.createConnection({
    ...baseOpts(dbName),
    multipleStatements: true,
  });
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB`);
    const [rows] = await conn.query("SELECT filename FROM _migrations");
    const applied = new Set(rows.map((r) => r.filename));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await conn.query(sql);
      await conn.query("INSERT INTO _migrations (filename) VALUES (?)", [file]);
    }
  } finally {
    await conn.end();
  }

  // Record provisioning in the shared registry.
  await safeQuery(
    `INSERT INTO org_databases (org_id, db_name, migrations_at)
     VALUES (?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE migrations_at = NOW(3)`,
    [orgId, dbName],
  );
  return { ok: true, provisioned: true, db_name: dbName };
}
