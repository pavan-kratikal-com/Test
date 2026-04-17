// Shared MySQL pool. Every service that needs MySQL imports getPool().
import mysql from "mysql2/promise";

let pool = null;

export function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "mysql",
    port: Number(process.env.MYSQL_PORT || 3306),
    socketPath: process.env.MYSQL_SOCKET || undefined,
    user: process.env.MYSQL_USER || "etdp",
    password: process.env.MYSQL_PASSWORD || "etdp",
    database: process.env.MYSQL_DATABASE || "etdp",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 10),
    namedPlaceholders: false,
    timezone: "Z",
  });
  return pool;
}

// Best-effort wrapper: never throw to the caller during scaffold runs where
// the DB might be unreachable. Engines fail open.
export async function safeQuery(sql, params = []) {
  try {
    const [rows] = await getPool().query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}
