// E5 URL Scanner — tests focus on pure helpers (analyzeStaticUrl, isDgaLike,
// registrableDomain). The async analyze() and scanUrl() require network +
// MySQL so are exercised in the smoke test instead.
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeStaticUrl, registrableDomain, isDgaLike, hashUrl,
  URL_SHORTENERS, SUSPICIOUS_TLDS,
} from "../services/e5_url_scanner/index.js";

test("analyzeStaticUrl: benign https://example.com emits no signals", () => {
  const s = analyzeStaticUrl(new URL("https://example.com/about"));
  assert.equal(s.length, 0);
});

test("analyzeStaticUrl: flags suspicious TLDs", () => {
  for (const tld of [".zip", ".top", ".xyz", ".click", ".mov"]) {
    const s = analyzeStaticUrl(new URL(`https://evil${tld}/phish`));
    const hit = s.find((x) => x.signal === "suspicious_tld");
    assert.ok(hit, `expected suspicious_tld for ${tld}`);
  }
});

test("analyzeStaticUrl: flags numeric IP hosts", () => {
  const s = analyzeStaticUrl(new URL("http://1.2.3.4/login"));
  assert.ok(s.find((x) => x.signal === "url_numeric_ip"));
});

test("analyzeStaticUrl: flags user:password URLs", () => {
  const s = analyzeStaticUrl(new URL("http://admin:secret@evil.com/"));
  assert.ok(s.find((x) => x.signal === "url_user_password"));
});

test("analyzeStaticUrl: flags excessive subdomains (>4 parts)", () => {
  const s = analyzeStaticUrl(new URL("https://a.b.c.d.e.example.com/x"));
  assert.ok(s.find((x) => x.signal === "domain_excessive_subdomains"));
});

test("analyzeStaticUrl: flags IDN/Punycode hostnames", () => {
  const s = analyzeStaticUrl(new URL("https://xn--80ak6aa92e.com/"));
  assert.ok(s.find((x) => x.signal === "domain_idn_homograph"));
});

test("analyzeStaticUrl: hits the seeded blocklist", () => {
  const s = analyzeStaticUrl(new URL("https://login-microsft.top/auth"));
  assert.ok(s.find((x) => x.signal === "reputation_blocklist_hit"));
});

test("analyzeStaticUrl: flags URL shorteners", () => {
  const s = analyzeStaticUrl(new URL("https://bit.ly/abcdef"));
  assert.ok(s.find((x) => x.signal === "url_shortener"));
});

test("analyzeStaticUrl: flags base64-like path segments", () => {
  const s = analyzeStaticUrl(new URL(
    "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  ));
  assert.ok(s.find((x) => x.signal === "url_base64_payload"));
});

test("analyzeStaticUrl: flags abnormally long paths", () => {
  const s = analyzeStaticUrl(new URL(`https://example.com/${"a".repeat(250)}`));
  assert.ok(s.find((x) => x.signal === "url_abnormal_path_length"));
});

test("registrableDomain: strips subdomains to eTLD+1", () => {
  assert.equal(registrableDomain("mail.example.com"), "example.com");
  assert.equal(registrableDomain("a.b.c.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
});

test("registrableDomain: handles co.uk-style two-label TLDs", () => {
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("server.api.example.co.in"), "example.co.in");
});

test("isDgaLike: flags vowel-starved high-entropy labels", () => {
  assert.equal(isDgaLike("xkqjptbnzw.com"), true);
});

test("isDgaLike: does not flag normal English words", () => {
  assert.equal(isDgaLike("example.com"), false);
  assert.equal(isDgaLike("microsoft.com"), false);
  assert.equal(isDgaLike("amazonaws.com"), false);
});

test("hashUrl: produces deterministic sha256 hex", () => {
  const a = hashUrl("https://x.com");
  const b = hashUrl("https://x.com");
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("URL_SHORTENERS and SUSPICIOUS_TLDS are exported and non-empty", () => {
  assert.ok(URL_SHORTENERS.size > 5);
  assert.ok(SUSPICIOUS_TLDS.length > 5);
});

// ── url_sender_url_mismatch (behavioral) ────────────────────────────
// analyze() is async and calls scanUrl which needs MySQL. We import it
// separately and test the full flow with the sender-domain enrichment.
import { analyze } from "../services/e5_url_scanner/index.js";

test("url_sender_url_mismatch fires when sender has never sent URLs from this domain", async () => {
  const s = await analyze({
    org_id: "o", message_id: "m", sender: "alice@acme.com",
    recipients: ["bob@acme.com"], subject: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [],
    body_text: "Click here: https://evil-site.com/phish",
    _sender_url_domains: ["acme.com", "google.com"],
  });
  assert.ok(s.some((x) => x.signal === "url_sender_url_mismatch"));
});

test("url_sender_url_mismatch does NOT fire when domain is in sender history", async () => {
  const s = await analyze({
    org_id: "o", message_id: "m", sender: "alice@acme.com",
    recipients: ["bob@acme.com"], subject: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [],
    body_text: "Click here: https://google.com/doc",
    _sender_url_domains: ["acme.com", "google.com"],
  });
  assert.equal(s.some((x) => x.signal === "url_sender_url_mismatch"), false);
});

test("url_sender_url_mismatch does NOT fire when _sender_url_domains is absent", async () => {
  const s = await analyze({
    org_id: "o", message_id: "m", sender: "alice@acme.com",
    recipients: ["bob@acme.com"], subject: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [],
    body_text: "Click here: https://evil-site.com/phish",
  });
  assert.equal(s.some((x) => x.signal === "url_sender_url_mismatch"), false);
});

// ── url_behavioral_novelty ──────────────────────────────────────────

test("url_behavioral_novelty fires when URL domain registered <7 days ago", async () => {
  const recentDate = new Date(Date.now() - 2 * 86400000).toISOString();
  const s = await analyze({
    org_id: "o", message_id: "m", sender: "alice@acme.com",
    recipients: ["bob@acme.com"], subject: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [],
    body_text: "Click here: https://new-domain.com/offer",
    _rdap_url_data: { "new-domain.com": { registration_date: recentDate } },
  });
  assert.ok(s.some((x) => x.signal === "url_behavioral_novelty"));
});

test("url_behavioral_novelty does NOT fire when domain registered >7 days ago", async () => {
  const oldDate = new Date(Date.now() - 30 * 86400000).toISOString();
  const s = await analyze({
    org_id: "o", message_id: "m", sender: "alice@acme.com",
    recipients: ["bob@acme.com"], subject: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [],
    body_text: "Click here: https://established.com/page",
    _rdap_url_data: { "established.com": { registration_date: oldDate } },
  });
  assert.equal(s.some((x) => x.signal === "url_behavioral_novelty"), false);
});
