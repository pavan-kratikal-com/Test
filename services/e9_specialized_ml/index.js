// E9 Specialized ML — Phase 2 complete: 13 signals per PRD §7.9.
//
// All 13 implemented as pure logic, no ML model runtime required.
//
//   Homoglyph (3):   mixed_script_domain, confusable_chars, idn_lookalike
//   Header (4):      header_order_anomaly, unusual_header_combo,
//                    received_chain_forged, message_id_format_anomaly
//   Encoding (3):    base64_content_obfuscation, quoted_printable_abuse,
//                    exotic_charset
//   Structural (3):  mime_tree_deep, nested_multipart_abuse,
//                    content_type_mismatch
import { makeApp, listen } from "@etdp/shared/engineBase";

function sig(name, score, detail = {}) {
  return { engine: "specialized_ml", signal: name, score, detail };
}

// ── Homoglyph / confusable characters ─────────────────────────────────

// Map of common Unicode confusables → ASCII equivalents.  Partial but
// covers the brand-impersonation cases the PRD calls out (Cyrillic а/о/е,
// Greek ο, look-alike digits).  Real impl would use the Unicode
// confusables.txt dataset (~6k chars).
const CONFUSABLES = new Map([
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["х", "x"],
  ["у", "y"], ["і", "i"], ["ѕ", "s"], ["ԁ", "d"], ["ɡ", "g"],
  ["ο", "o"], ["ε", "e"], ["ρ", "p"], ["α", "a"], ["ν", "v"],
]);

function detectConfusable(s) {
  const hits = [];
  for (const ch of s) {
    if (CONFUSABLES.has(ch)) hits.push({ ch, ascii: CONFUSABLES.get(ch) });
  }
  return hits;
}

function hasMixedScript(s) {
  let asciiAlpha = false, nonAsciiAlpha = false;
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue;
    if (ch.codePointAt(0) < 128) asciiAlpha = true;
    else nonAsciiAlpha = true;
  }
  return asciiAlpha && nonAsciiAlpha;
}

// Common brands to check for IDN lookalikes.  Real impl uses a learned
// per-org allowlist; this is a seed.
const COMMON_BRANDS = [
  "microsoft", "google", "paypal", "amazon", "apple", "facebook",
  "instagram", "netflix", "linkedin", "github", "slack", "zoom",
];

function editDist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[a.length];
}

function idnLookalikeBrand(hostname) {
  const label = hostname.toLowerCase().split(".")[0];
  for (const brand of COMMON_BRANDS) {
    if (label === brand) continue;
    const d = editDist(label, brand, 2);
    if (d > 0 && d <= 2) return { brand, label, distance: d };
  }
  return null;
}

// ── Header anomalies ──────────────────────────────────────────────────

// A "normal" header order for most MUAs: From ~ To ~ Subject ~ Date ~ Message-Id.
// We approximate by checking whether common headers appear in order.
const EXPECTED_HEADER_ORDER = ["from", "to", "subject", "date", "message-id"];

function headerOrderAnomaly(headers) {
  if (!headers || Object.keys(headers).length === 0) return null;
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  const positions = EXPECTED_HEADER_ORDER
    .map((h) => names.indexOf(h))
    .filter((i) => i >= 0);
  // Check strict ascending order (more permissive would need Jaccard/z-score).
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1]) {
      return { actual_order: names };
    }
  }
  return null;
}

function unusualHeaderCombo(headers) {
  if (!headers) return null;
  const keys = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  // X-PHP-Originating-Script + X-Mailer: very common in scripted spam.
  if (keys.has("x-php-originating-script")) {
    return { smells: "x-php-originating-script present" };
  }
  // Reply-To set to a different domain than From.
  if (keys.has("reply-to") && keys.has("from")) {
    const fr = String(headers["From"] || headers["from"] || "");
    const rt = String(headers["Reply-To"] || headers["reply-to"] || "");
    const frDom = fr.match(/@([\w.-]+)/)?.[1];
    const rtDom = rt.match(/@([\w.-]+)/)?.[1];
    if (frDom && rtDom && frDom !== rtDom) {
      return { reply_to_domain: rtDom, from_domain: frDom };
    }
  }
  return null;
}

function receivedChainForged(headers) {
  if (!headers) return null;
  const received = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "received") received.push(String(v));
  }
  if (received.length === 0) return null;
  // Forged chains often have impossibly close timestamps or reverse order.
  const times = received.map((r) => {
    const m = r.match(/;\s*(.+)$/);
    if (!m) return null;
    const d = new Date(m[1].trim());
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }).filter((t) => t !== null);
  if (times.length >= 2) {
    // Check reverse chronological (top received should be newest).
    for (let i = 1; i < times.length; i++) {
      if (times[i] > times[i - 1]) {
        return { reason: "non_monotonic_timestamps" };
      }
    }
  }
  return null;
}

function messageIdFormatAnomaly(headers, sender) {
  if (!headers) return null;
  const mid = headers["Message-ID"] || headers["Message-Id"] || headers["message-id"];
  if (!mid) return { reason: "missing_message_id" };
  // Standard: <something@domain>
  const m = String(mid).match(/<[^@>]+@([^>]+)>/);
  if (!m) return { reason: "malformed_message_id", value: String(mid).slice(0, 80) };
  if (sender?.includes("@")) {
    const senderDom = sender.split("@")[1].toLowerCase();
    const midDom = m[1].toLowerCase();
    // Message-ID domain that has no relation to sender is a weak signal
    // but common with bulk senders, so require a very distant mismatch.
    if (midDom && senderDom && !midDom.endsWith(senderDom)
        && !senderDom.endsWith(midDom) && editDist(midDom, senderDom, 4) > 3) {
      return { sender_domain: senderDom, message_id_domain: midDom };
    }
  }
  return null;
}

// ── Encoding abuse ────────────────────────────────────────────────────

function base64BodyObfuscation(email) {
  const body = email.body_text || "";
  // Look for a large contiguous base64-only block (>200 chars) in the body.
  const match = body.match(/[A-Za-z0-9+/=]{200,}/);
  if (!match) return null;
  // Skip DKIM-signature-like blocks.
  if (/dkim|signature|boundary/i.test(body.slice(Math.max(0, match.index - 60), match.index))) {
    return null;
  }
  return { length: match[0].length };
}

function quotedPrintableAbuse(email) {
  const body = email.body_text || email.body_html || "";
  const qpCount = (body.match(/=[0-9A-F]{2}/g) || []).length;
  // Lots of encoded characters where they don't belong → evasion.
  if (qpCount > 40 && body.length > 0 && qpCount / body.length > 0.05) {
    return { qp_sequences: qpCount };
  }
  return null;
}

function exoticCharset(email) {
  const type = email.headers?.["Content-Type"] || email.headers?.["content-type"];
  if (!type) return null;
  const m = String(type).match(/charset\s*=\s*["']?([\w-]+)/i);
  if (!m) return null;
  const charset = m[1].toLowerCase();
  const common = new Set(["utf-8", "us-ascii", "iso-8859-1", "windows-1252", "utf-16"]);
  if (!common.has(charset)) {
    return { charset };
  }
  return null;
}

// ── Structural anomaly (MIME tree) ────────────────────────────────────

function detectMimeAnomalies(email) {
  const signals = [];
  const raw = email.raw_mime || "";
  if (!raw) return signals;
  // Depth: how many distinct multipart boundaries appear?
  const boundaries = [...new Set((raw.match(/boundary\s*=\s*["']?[^"'\r\n;]+/gi) || []))];
  if (boundaries.length >= 4) {
    signals.push(sig("mime_tree_deep", 1.5, { boundary_count: boundaries.length }));
  }
  if (boundaries.length >= 6) {
    signals.push(sig("nested_multipart_abuse", 2.25, { boundary_count: boundaries.length }));
  }
  // Content-type mismatch: declared multipart but no boundary, or vice versa.
  const topType = raw.match(/^Content-Type:\s*([\w\/-]+)/im)?.[1];
  if (topType === "multipart" && boundaries.length === 0) {
    signals.push(sig("content_type_mismatch", 2.25,
      { declared: "multipart", actual: "no_boundary" }));
  }
  return signals;
}

// ── Entry point ───────────────────────────────────────────────────────

export function analyze(email) {
  const signals = [];
  const domain = email.sender?.includes("@") ? email.sender.split("@")[1] : "";

  // Homoglyph group
  if (domain && hasMixedScript(domain)) {
    signals.push(sig("mixed_script_domain", 4.5, { domain }));
  }
  const subjConf = detectConfusable(email.subject || "");
  const domConf = domain ? detectConfusable(domain) : [];
  if (subjConf.length + domConf.length > 0) {
    signals.push(sig("confusable_chars", 3.0,
      { subject: subjConf, domain: domConf }));
  }
  if (domain) {
    const lookalike = idnLookalikeBrand(domain);
    if (lookalike) signals.push(sig("idn_lookalike", 4.5, lookalike));
  }

  // Header group
  const hOrder = headerOrderAnomaly(email.headers);
  if (hOrder) signals.push(sig("header_order_anomaly", 1.05, hOrder));
  const hCombo = unusualHeaderCombo(email.headers);
  if (hCombo) signals.push(sig("unusual_header_combo", 2.25, hCombo));
  const rcvForged = receivedChainForged(email.headers);
  if (rcvForged) signals.push(sig("received_chain_forged", 3.0, rcvForged));
  const midAnom = messageIdFormatAnomaly(email.headers, email.sender);
  if (midAnom) signals.push(sig("message_id_format_anomaly", 1.5, midAnom));

  // Encoding group
  const b64 = base64BodyObfuscation(email);
  if (b64) signals.push(sig("base64_content_obfuscation", 2.25, b64));
  const qp = quotedPrintableAbuse(email);
  if (qp) signals.push(sig("quoted_printable_abuse", 1.5, qp));
  const charset = exoticCharset(email);
  if (charset) signals.push(sig("exotic_charset", 1.5, charset));

  // Structural group
  signals.push(...detectMimeAnomalies(email));

  return signals;
}

export {
  CONFUSABLES, COMMON_BRANDS,
  detectConfusable, hasMixedScript, idnLookalikeBrand,
  headerOrderAnomaly, unusualHeaderCombo, receivedChainForged, messageIdFormatAnomaly,
  base64BodyObfuscation, quotedPrintableAbuse, exoticCharset,
  detectMimeAnomalies, editDist,
};

const app = makeApp("e9_specialized_ml", analyze);
listen(app, "e9_specialized_ml");
