// RDAP domain registration lookup with two-tier cache (Redis → MySQL).
//
// Hot path:       lookupRdapCached(domain)   → Redis → MySQL → null
// Background:     fetchRdapBackground(domain) → RDAP fetch → MySQL upsert → Redis set
//
// Domain registration dates are global facts, so the cache lives in the
// shared DB (same pattern as url_scan_cache).
import { cacheGet, cacheSet } from "@etdp/shared/cache";
import { safeQuery } from "@etdp/shared/mysql";

const REDIS_TTL = 86400;      // 24 hours
const MYSQL_TTL_DAYS = 7;
const RDAP_TIMEOUT_MS = 8000;
const REDIS_PREFIX = "rdap:";

// ── Rate limiting ───────────────────────────────────────────────────────
const BUCKET_MAX = 10;
const REFILL_RATE = 1; // tokens per second
let tokens = BUCKET_MAX;
let lastRefill = Date.now();

function takeToken() {
  const now = Date.now();
  tokens = Math.min(BUCKET_MAX, tokens + (now - lastRefill) / 1000 * REFILL_RATE);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

// ── In-flight dedup ─────────────────────────────────────────────────────
const inflight = new Set();

// ── RDAP JSON parsing ───────────────────────────────────────────────────
export function parseRdapRegistration(rdapJson) {
  const result = { registration_date: null, expiration_date: null, registrar: null };
  if (!rdapJson || typeof rdapJson !== "object") return result;

  const events = rdapJson.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev.eventAction === "registration" && ev.eventDate) {
        const d = new Date(ev.eventDate);
        if (!Number.isNaN(d.getTime())) result.registration_date = d;
      }
      if (ev.eventAction === "expiration" && ev.eventDate) {
        const d = new Date(ev.eventDate);
        if (!Number.isNaN(d.getTime())) result.expiration_date = d;
      }
    }
  }

  // Registrar from entities with "registrar" role.
  const entities = rdapJson.entities;
  if (Array.isArray(entities)) {
    for (const ent of entities) {
      if (Array.isArray(ent.roles) && ent.roles.includes("registrar")) {
        result.registrar = ent.vcardArray?.[1]
          ?.find((v) => v[0] === "fn")?.[3]
          || ent.handle
          || null;
        break;
      }
    }
  }

  return result;
}

// ── Cached lookup (hot path) ────────────────────────────────────────────
export async function lookupRdapCached(domain) {
  if (!domain) return null;

  // Tier 1: Redis
  try {
    const cached = await cacheGet(`${REDIS_PREFIX}${domain}`);
    if (cached !== null) {
      return JSON.parse(cached);
    }
  } catch { /* fall through */ }

  // Tier 2: MySQL (7-day TTL)
  try {
    const r = await safeQuery(
      `SELECT registration_date, expiration_date, registrar, rdap_status
       FROM domain_rdap_cache
       WHERE domain = ? AND queried_at > NOW() - INTERVAL ? DAY
       LIMIT 1`,
      [domain, MYSQL_TTL_DAYS],
    );
    if (r.ok && r.rows.length > 0) {
      const row = r.rows[0];
      const data = {
        registration_date: row.registration_date ? new Date(row.registration_date).toISOString() : null,
        expiration_date: row.expiration_date ? new Date(row.expiration_date).toISOString() : null,
        registrar: row.registrar,
        rdap_status: row.rdap_status,
      };
      // Backfill Redis
      await cacheSet(`${REDIS_PREFIX}${domain}`, JSON.stringify(data), REDIS_TTL);
      return data;
    }
  } catch { /* fall through */ }

  return null;
}

// ── Background RDAP fetch ───────────────────────────────────────────────
export function fetchRdapBackground(domain) {
  if (!domain || inflight.has(domain)) return;
  if (!takeToken()) return;

  inflight.add(domain);
  setImmediate(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);

      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        signal: controller.signal,
        headers: { Accept: "application/rdap+json" },
      });
      clearTimeout(timer);

      let rdap_status = "ok";
      let data = { registration_date: null, expiration_date: null, registrar: null };
      let rdapRaw = null;

      if (res.status === 404) {
        rdap_status = "not_found";
      } else if (res.status === 429) {
        rdap_status = "rate_limited";
      } else if (!res.ok) {
        rdap_status = "error";
      } else {
        rdapRaw = await res.json();
        data = parseRdapRegistration(rdapRaw);
      }

      // Upsert MySQL
      await safeQuery(
        `INSERT INTO domain_rdap_cache
           (domain, registration_date, expiration_date, registrar, rdap_status, rdap_raw, queried_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE
           registration_date = VALUES(registration_date),
           expiration_date   = VALUES(expiration_date),
           registrar         = VALUES(registrar),
           rdap_status       = VALUES(rdap_status),
           rdap_raw          = VALUES(rdap_raw),
           queried_at        = NOW(3)`,
        [
          domain,
          data.registration_date,
          data.expiration_date,
          data.registrar,
          rdap_status,
          rdapRaw ? JSON.stringify(rdapRaw) : null,
        ],
      );

      // Set Redis
      const cacheData = {
        registration_date: data.registration_date ? data.registration_date.toISOString() : null,
        expiration_date: data.expiration_date ? data.expiration_date.toISOString() : null,
        registrar: data.registrar,
        rdap_status,
      };
      await cacheSet(`${REDIS_PREFIX}${domain}`, JSON.stringify(cacheData), REDIS_TTL);
    } catch {
      // Silent failure — next email will retry
    } finally {
      inflight.delete(domain);
    }
  });
}
