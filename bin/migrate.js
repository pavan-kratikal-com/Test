#!/usr/bin/env node
// Apply db/migrations/*.sql in lexicographic order. Idempotent — tracks
// applied filenames in `_migrations`. Safe to run on every container start.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || join(ROOT, "db", "migrations");

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "mysql",
  port: Number(process.env.MYSQL_PORT || 3306),
  socketPath: process.env.MYSQL_SOCKET || undefined,
  user: process.env.MYSQL_USER || "etdp",
  password: process.env.MYSQL_PASSWORD || "etdp",
  database: process.env.MYSQL_DATABASE || "etdp",
  multipleStatements: true,
});

await conn.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB
`);

const [appliedRows] = await conn.query("SELECT filename FROM _migrations");
const applied = new Set(appliedRows.map((r) => r.filename));

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  if (applied.has(file)) {
    console.log(`[migrate] skip  ${file}`);
    continue;
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  await conn.query(sql);
  await conn.query("INSERT INTO _migrations (filename) VALUES (?)", [file]);
  console.log(`[migrate] apply ${file}`);
}

await conn.end();
console.log("[migrate] done");
