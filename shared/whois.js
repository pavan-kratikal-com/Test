// Lightweight domain-metadata lookup using node:dns only (no external
// WHOIS API). Produces the signals we need for E5 URL Scanner:
//
//   { resolves:    bool    — A or AAAA record exists
//     has_mx:      bool    — MX record exists (real email infra)
//     ns:          string[] — nameservers
//     soa_serial:  string  — approximate "last edit" indicator from SOA
//     txt_count:   number  — TXT records (SPF/verification presence)
//     appears_parked: bool — heuristic: one A + no MX + TXT says parked
//   }
//
// Integrations that want a hard "domain was registered N days ago"
// should use a real WHOIS source (RDAP, whois CLI, SecurityTrails).
// The helper below deliberately avoids those so dev works offline.
import dns from "node:dns/promises";

// 4-second budget per lookup; DNS resolvers in CI can be slow.
const DEFAULT_TIMEOUT = 4_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns_timeout")), ms)),
  ]);
}

async function safeDns(fn, ...args) {
  try { return await withTimeout(fn(...args), DEFAULT_TIMEOUT); }
  catch { return null; }
}

export async function lookupDomain(hostname) {
  const lower = hostname.toLowerCase();
  const [a, aaaa, mx, ns, txt, soa] = await Promise.all([
    safeDns(dns.resolve4.bind(dns), lower),
    safeDns(dns.resolve6.bind(dns), lower),
    safeDns(dns.resolveMx.bind(dns), lower),
    safeDns(dns.resolveNs.bind(dns), lower),
    safeDns(dns.resolveTxt.bind(dns), lower),
    safeDns(dns.resolveSoa.bind(dns), lower),
  ]);

  const resolves = (a && a.length > 0) || (aaaa && aaaa.length > 0);
  const has_mx = mx && mx.length > 0;
  const nsList = (ns || []).slice(0, 8);
  const txtFlat = (txt || []).map((chunks) => chunks.join("")).slice(0, 16);
  const soaSerial = soa?.serial ? String(soa.serial) : null;
  const hasSpf = txtFlat.some((t) => /^v=spf1/i.test(t));
  const hasDmarc = txtFlat.some((t) => /^v=dmarc/i.test(t));

  // Parked-domain heuristic: resolves, single A record, no MX, no SPF,
  // often a single parking-nameserver.
  const appearsParked = resolves && (a?.length === 1) && !has_mx && !hasSpf;

  return {
    hostname: lower,
    resolves, has_mx,
    ns: nsList,
    soa_serial: soaSerial,
    txt_count: txtFlat.length,
    has_spf: hasSpf,
    has_dmarc: hasDmarc,
    appears_parked: appearsParked,
  };
}

// Translate a lookupDomain() result into E5-style signals.
export function domainMetaSignals(meta) {
  const signals = [];
  if (!meta) return signals;
  if (!meta.resolves) {
    signals.push({
      engine: "url_scanner", signal: "domain_unresolvable",
      score: 2.5, detail: { host: meta.hostname },
    });
  }
  if (meta.resolves && !meta.has_mx && !meta.has_spf && !meta.has_dmarc) {
    signals.push({
      engine: "url_scanner", signal: "domain_no_mail_infra",
      score: 1.2, detail: { host: meta.hostname, reason: "no MX / SPF / DMARC records" },
    });
  }
  if (meta.appears_parked) {
    signals.push({
      engine: "url_scanner", signal: "domain_appears_parked",
      score: 1.0, detail: { host: meta.hostname },
    });
  }
  return signals;
}
