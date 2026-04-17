// E5 URL Scanner — Phase 2 real implementation.
//
// Signals emitted (subset of the PRD §7.5 29-signal list that's feasible
// without a full headless browser; ones marked DATA_DEP need Playwright
// or external reputation APIs):
//
//   Domain analysis:
//     domain_idn_homograph        — detected Punycode / IDN
//     domain_numeric_ip           — http://1.2.3.4/...
//     domain_excessive_subdomains — >3 subdomains
//     domain_dga_like             — high-entropy or vowel-starved
//     suspicious_tld              — list of known-abused TLDs
//   Redirect chain:
//     redirect_chain_long         — >=3 hops
//     redirect_domain_hops        — redirect crosses >=2 distinct domains
//     url_shortener               — short-link service in chain
//   Landing page:
//     landing_credential_form     — password field on final page
//     landing_form_domain_mismatch — form posts to different registrable domain
//     landing_obfuscated_js       — eval()/fromCharCode on page
//     landing_hidden_iframe       — hidden iframe element
//   Reputation:
//     reputation_blocklist_hit    — local seeded blocklist match
//   URL structure:
//     url_user_password           — http://user:pass@...
//     url_data_uri                — data:text/html,...
//     url_base64_payload          — base64 blob in path
//     url_abnormal_path_length    — path > 200 chars
//
// Cache: url_scan_cache table in etdp_shared (24h TTL).  A single scan
// of the same URL across any org reuses the cached result.
import crypto from "node:crypto";
import { request } from "undici";
import { makeApp, listen } from "@etdp/shared/engineBase";
import { safeQuery } from "@etdp/shared/mysql";

const URL_RE = /https?:\/\/[^\s<>"'\x00-\x1f]+/gi;
const URL_SHORTENERS = new Set([
  "bit.ly", "t.co", "goo.gl", "tinyurl.com", "ow.ly", "is.gd",
  "buff.ly", "rebrand.ly", "s.id", "cutt.ly", "tiny.cc",
]);
const SUSPICIOUS_TLDS = [
  ".zip", ".mov", ".top", ".xyz", ".click", ".loan", ".work",
  ".rest", ".country", ".cf", ".tk", ".ml", ".ga", ".gq",
];

// Small seeded blocklist. Real impl queries SafeBrowsing/PhishTank/VirusTotal.
const LOCAL_BLOCKLIST = new Set([
  "login-microsft.top",
  "paypa1-secure.zip",
  "example-corp.click",
]);

const MAX_REDIRECTS = 5;
const HEAD_TIMEOUT_MS = 4_000;
const GET_BODY_LIMIT = 256 * 1024; // 256 KB landing-page sniff cap

function sig(name, score, detail = {}) {
  return { engine: "url_scanner", signal: name, score, detail };
}

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function parseUrlSafe(u) {
  try { return new URL(u); } catch { return null; }
}

function registrableDomain(hostname) {
  // Simplified effective-TLD heuristic: last two labels, or last three
  // for known two-label TLDs (.co.uk, .com.au, .co.in). Good enough for
  // the domain-mismatch signal; real impl would use tldts/publicsuffix.
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return hostname.toLowerCase();
  const secondLast = parts[parts.length - 2];
  if (["co", "com", "net", "org", "gov", "ac"].includes(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function hasIpHost(u) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname);
}

function hasIdn(u) {
  return u.hostname.startsWith("xn--") || u.hostname.includes(".xn--");
}

function entropyOfLabel(label) {
  const freq = Object.create(null);
  for (const c of label) freq[c] = (freq[c] || 0) + 1;
  let H = 0;
  const n = label.length;
  for (const c of Object.keys(freq)) {
    const p = freq[c] / n;
    H -= p * Math.log2(p);
  }
  return H;
}

// Entropy is the common DGA heuristic; combine with "no vowels" for short domains.
function isDgaLike(hostname) {
  const label = hostname.split(".")[0];
  if (label.length < 8) return false;
  const vowels = (label.match(/[aeiouy]/gi) || []).length;
  const vowelRatio = vowels / label.length;
  const H = entropyOfLabel(label);
  // Low vowel ratio AND high-entropy consonant mix.
  return H > 3.0 && vowelRatio < 0.2;
}

function analyzeStaticUrl(u) {
  const signals = [];
  if (!u) return signals;

  if (hasIpHost(u)) {
    signals.push(sig("url_numeric_ip", 2.0, { host: u.hostname }));
  }
  if (hasIdn(u)) {
    signals.push(sig("domain_idn_homograph", 2.0, { host: u.hostname }));
  }
  if (u.hostname.split(".").length > 4) {
    signals.push(sig("domain_excessive_subdomains", 1.0,
      { subdomain_count: u.hostname.split(".").length - 2 }));
  }
  if (isDgaLike(u.hostname)) {
    signals.push(sig("domain_dga_like", 1.5, { host: u.hostname }));
  }
  const tldHit = SUSPICIOUS_TLDS.find((tld) => u.hostname.endsWith(tld));
  if (tldHit) {
    signals.push(sig("suspicious_tld", 2.0, { tld: tldHit, host: u.hostname }));
  }
  if (u.username || u.password) {
    signals.push(sig("url_user_password", 2.5, { userinfo: true }));
  }
  if (u.protocol === "data:") {
    signals.push(sig("url_data_uri", 2.5));
  }
  if (/[A-Za-z0-9+/=]{60,}/.test(u.pathname)) {
    signals.push(sig("url_base64_payload", 1.5));
  }
  if (u.pathname.length > 200) {
    signals.push(sig("url_abnormal_path_length", 0.8,
      { path_length: u.pathname.length }));
  }
  if (URL_SHORTENERS.has(u.hostname)) {
    signals.push(sig("url_shortener", 1.0, { service: u.hostname }));
  }
  if (LOCAL_BLOCKLIST.has(u.hostname)) {
    signals.push(sig("reputation_blocklist_hit", 4.0,
      { host: u.hostname, source: "local" }));
  }
  return signals;
}

// Follow redirects with HEAD (fallback to GET on 405/no-Location).
async function followRedirects(startUrl, maxHops = MAX_REDIRECTS) {
  const chain = [startUrl];
  const domains = new Set([(parseUrlSafe(startUrl))?.hostname].filter(Boolean));
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    try {
      const { statusCode, headers } = await request(current, {
        method: "HEAD",
        maxRedirections: 0,
        headersTimeout: HEAD_TIMEOUT_MS,
        bodyTimeout: HEAD_TIMEOUT_MS,
      });
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        const loc = String(headers.location);
        const next = new URL(loc, current).toString();
        chain.push(next);
        const host = parseUrlSafe(next)?.hostname;
        if (host) domains.add(host);
        current = next;
        continue;
      }
      return { finalUrl: current, status: statusCode, chain, domains };
    } catch (err) {
      return { finalUrl: current, status: null, chain, domains, error: err.message };
    }
  }
  return { finalUrl: current, status: null, chain, domains, error: "too_many_redirects" };
}

// Fetch landing page HTML (capped) and parse for phishy affordances.
async function analyzeLandingPage(url) {
  const signals = [];
  let html = "";
  try {
    const { body, headers } = await request(url, {
      method: "GET",
      maxRedirections: 3,
      headersTimeout: HEAD_TIMEOUT_MS,
      bodyTimeout: HEAD_TIMEOUT_MS,
    });
    const type = String(headers["content-type"] || "");
    if (!type.includes("html")) return signals;
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > GET_BODY_LIMIT) { body.destroy(); break; }
      html += chunk.toString("utf8");
    }
  } catch { return signals; }

  if (/<input[^>]+type=["']?password/i.test(html)) {
    signals.push(sig("landing_credential_form", 3.0));
  }
  const formMatch = html.match(/<form[^>]+action=["']([^"']+)/i);
  if (formMatch) {
    const formAction = formMatch[1];
    try {
      const absAction = new URL(formAction, url).toString();
      const pageReg = registrableDomain(new URL(url).hostname);
      const actReg = registrableDomain(new URL(absAction).hostname);
      if (pageReg !== actReg) {
        signals.push(sig("landing_form_domain_mismatch", 2.5,
          { page_domain: pageReg, form_action_domain: actReg }));
      }
    } catch { /* ignore */ }
  }
  if (/eval\s*\(|String\.fromCharCode|unescape\s*\(/i.test(html)) {
    signals.push(sig("landing_obfuscated_js", 1.5));
  }
  if (/<iframe[^>]+(?:style=["'][^"']*display\s*:\s*none|hidden)/i.test(html)) {
    signals.push(sig("landing_hidden_iframe", 1.5));
  }
  return signals;
}

// Pull a single URL through the full analysis pipeline (cache-first).
async function scanUrl(rawUrl) {
  const hash = hashUrl(rawUrl);
  // Cache lookup (24h TTL).
  const cached = await safeQuery(
    `SELECT final_url, redirect_hops, final_status, risk_score, signals, scanned_at
     FROM url_scan_cache WHERE url_hash = ?
       AND scanned_at > NOW() - INTERVAL 24 HOUR LIMIT 1`,
    [hash],
  );
  if (cached.ok && cached.rows.length > 0) {
    const row = cached.rows[0];
    const signals = typeof row.signals === "string" ? JSON.parse(row.signals) : row.signals;
    signals.push(sig("url_scan_cache_hit", 0, { hash, scanned_at: row.scanned_at }));
    return signals;
  }

  const u = parseUrlSafe(rawUrl);
  const staticSignals = analyzeStaticUrl(u);
  let redirectSignals = [];
  let landingSignals = [];
  let redirResult = { chain: [rawUrl], domains: new Set(), finalUrl: rawUrl, status: null };

  if (u && /^https?:$/.test(u.protocol)) {
    redirResult = await followRedirects(rawUrl);
    if (redirResult.chain.length - 1 >= 3) {
      redirectSignals.push(sig("redirect_chain_long", 2.0,
        { hops: redirResult.chain.length - 1 }));
    }
    if (redirResult.domains.size >= 2) {
      redirectSignals.push(sig("redirect_domain_hops", 1.5,
        { domain_hops: redirResult.domains.size }));
    }
    if (redirResult.finalUrl !== rawUrl) {
      // Analyze the final URL's static shape too.
      redirectSignals.push(...analyzeStaticUrl(parseUrlSafe(redirResult.finalUrl)).map((s) => ({
        ...s, detail: { ...s.detail, via: "final_url" },
      })));
    }
    // Best-effort landing-page fetch.
    if (redirResult.status && redirResult.status >= 200 && redirResult.status < 400) {
      landingSignals = await analyzeLandingPage(redirResult.finalUrl);
    }
  }

  const all = [...staticSignals, ...redirectSignals, ...landingSignals];
  const risk = all.reduce((a, s) => a + (s.score || 0), 0);

  // Persist to cache (truncate URL to column limit).
  await safeQuery(
    `INSERT INTO url_scan_cache
       (url_hash, url, final_url, redirect_hops, final_status, risk_score, signals)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       final_url=VALUES(final_url), redirect_hops=VALUES(redirect_hops),
       final_status=VALUES(final_status), risk_score=VALUES(risk_score),
       signals=VALUES(signals), scanned_at=NOW(3)`,
    [hash, rawUrl.slice(0, 2048), (redirResult.finalUrl || "").slice(0, 2048),
      redirResult.chain.length - 1, redirResult.status, risk, JSON.stringify(all)],
  );
  return all;
}

export async function analyze(email) {
  const urls = (email.body_text || "").match(URL_RE) || [];
  // Also pick up URLs in HTML bodies crudely.
  if (email.body_html) {
    urls.push(...(email.body_html.match(URL_RE) || []));
  }
  // Dedup.
  const unique = [...new Set(urls)].slice(0, 10); // safety cap
  if (unique.length === 0) return [];

  const perUrl = await Promise.all(unique.map((u) => scanUrl(u).catch(() => [])));
  const flat = perUrl.flat();
  flat.push(sig("urls_present", 0, { count: unique.length, unique_hosts: new Set(unique.map((u) => parseUrlSafe(u)?.hostname).filter(Boolean)).size }));
  return flat;
}

export {
  analyzeStaticUrl, followRedirects, analyzeLandingPage, scanUrl,
  registrableDomain, isDgaLike, hashUrl, URL_SHORTENERS, SUSPICIOUS_TLDS,
};

const app = makeApp("e5_url_scanner", analyze);
listen(app, "e5_url_scanner");
