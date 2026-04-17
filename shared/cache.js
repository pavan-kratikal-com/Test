// Redis-backed cache with no-op fallback when Redis is unreachable.
// Used by Stats DB to short-circuit hot lookups (first-time sender,
// domain-first-seen, sender daily aggregates).
import { createClient } from "redis";

let client = null;
let connecting = null;

async function getClient() {
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) return null;
  if (client?.isReady) return client;
  if (connecting) return connecting;
  const url = process.env.REDIS_URL
    || `redis://${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || 6379}`;
  connecting = (async () => {
    const c = createClient({ url });
    c.on("error", () => { /* silent in scaffold; fallback to no-op */ });
    try {
      await c.connect();
      client = c;
      return c;
    } catch {
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export async function cacheGet(key) {
  const c = await getClient();
  if (!c) return null;
  try { return await c.get(key); } catch { return null; }
}

export async function cacheSet(key, value, ttlSec = 3600) {
  const c = await getClient();
  if (!c) return;
  try { await c.set(key, String(value), { EX: ttlSec }); } catch { /* noop */ }
}

// Memoize an async lookup. `loader` is called only on miss.
export async function cached(key, ttlSec, loader) {
  const hit = await cacheGet(key);
  if (hit !== null) {
    try { return JSON.parse(hit); } catch { return hit; }
  }
  const value = await loader();
  await cacheSet(key, JSON.stringify(value), ttlSec);
  return value;
}
