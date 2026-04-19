// URL reputation lookups.  Two real sources:
//
//   PhishTank     — pulls the free public feed once every 12h into Redis
//                   (or a local Map when Redis is unreachable).  Offline
//                   fallback: uses the bundled seed list.
//   Google SB v4  — https://safebrowsing.googleapis.com — lookup per URL.
//                   Requires GOOGLE_SAFE_BROWSING_API_KEY. Disabled when
//                   the key is unset.
//
// Caching: every lookup result (hit or miss) is memoized in Redis for
// REPUTATION_TTL seconds (default 12h) to bound API costs.
import { request } from "undici";
import { cacheGet, cacheSet } from "./cache.js";

const GSB_API_KEY = process.env.GOOGLE_SAFE_BROWSING_API_KEY || "";
const PHISHTANK_URL = process.env.PHISHTANK_URL
  || "http://data.phishtank.com/data/online-valid.json";
const REPUTATION_TTL = Number(process.env.REPUTATION_TTL_SEC || 12 * 3600);

// Local bundled seed — same list the scaffold has always used, extracted
// here so it can be overridden / extended without editing E5.
const SEED_BLOCKLIST = new Set([
  "login-microsft.top",
  "paypa1-secure.zip",
  "example-corp.click",
]);

let phishtankSet = null; // in-process cache of PhishTank hostnames
let phishtankRefreshedAt = 0;

export function seedBlocklist() {
  return SEED_BLOCKLIST;
}

// ── PhishTank ─────────────────────────────────────────────────────────

export async function refreshPhishTank({ force = false } = {}) {
  const age = Date.now() - phishtankRefreshedAt;
  if (!force && phishtankSet && age < 12 * 3600 * 1000) return phishtankSet;

  // Try Redis first — another replica may have already cached it.
  const cached = await cacheGet("phishtank:hostnames");
  if (!force && cached) {
    try {
      phishtankSet = new Set(JSON.parse(cached));
      phishtankRefreshedAt = Date.now();
      return phishtankSet;
    } catch { /* fall through */ }
  }

  try {
    const { statusCode, body } = await request(PHISHTANK_URL, {
      method: "GET",
      headersTimeout: 10_000,
      bodyTimeout: 30_000,
    });
    if (statusCode >= 400) throw new Error(`HTTP ${statusCode}`);
    const text = await body.text();
    const records = JSON.parse(text);
    const hosts = new Set();
    for (const r of records) {
      try { hosts.add(new URL(r.url).hostname.toLowerCase()); } catch { /* skip */ }
    }
    phishtankSet = hosts;
    phishtankRefreshedAt = Date.now();
    await cacheSet("phishtank:hostnames",
      JSON.stringify([...hosts]), 12 * 3600);
    return phishtankSet;
  } catch {
    // Network unavailable (common in dev/CI). Fall back to seed list.
    phishtankSet = new Set(SEED_BLOCKLIST);
    phishtankRefreshedAt = Date.now();
    return phishtankSet;
  }
}

export async function phishTankLookup(hostname) {
  const set = await refreshPhishTank();
  if (set.has(hostname.toLowerCase())) {
    return { hit: true, source: "phishtank" };
  }
  if (SEED_BLOCKLIST.has(hostname.toLowerCase())) {
    return { hit: true, source: "seed" };
  }
  return { hit: false };
}

// ── Google Safe Browsing v4 ───────────────────────────────────────────

export async function safeBrowsingLookup(urls) {
  if (!GSB_API_KEY || urls.length === 0) return { matches: [] };
  const cached = await cacheGet(`gsb:${urls[0]}`);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  try {
    const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(GSB_API_KEY)}`;
    const { statusCode, body } = await request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "etdp", clientVersion: "0.1" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: urls.slice(0, 50).map((u) => ({ url: u })),
        },
      }),
      bodyTimeout: 5_000,
      headersTimeout: 5_000,
    });
    if (statusCode >= 400) throw new Error(`HTTP ${statusCode}`);
    const json = JSON.parse(await body.text());
    await cacheSet(`gsb:${urls[0]}`, JSON.stringify(json), REPUTATION_TTL);
    return json;
  } catch (err) {
    return { matches: [], error: err.message };
  }
}

// Combined reputation check returning a list of Signal objects.
export async function reputationSignals(rawUrl) {
  const signals = [];
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    const pt = await phishTankLookup(host);
    if (pt.hit) {
      signals.push({
        engine: "url_scanner", signal: "reputation_phishtank_hit",
        score: 4.0, detail: { host, source: pt.source },
      });
    }

    if (GSB_API_KEY) {
      const gsb = await safeBrowsingLookup([rawUrl]);
      if (gsb.matches?.length) {
        const first = gsb.matches[0];
        signals.push({
          engine: "url_scanner", signal: "reputation_safebrowsing_hit",
          score: 4.5,
          detail: { host, threat_type: first.threatType, platform: first.platformType },
        });
      }
    }
  } catch { /* invalid URL — caller will ignore */ }
  return signals;
}
