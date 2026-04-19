import test from "node:test";
import assert from "node:assert/strict";
import { analyze, buildMime, rspamdToSignals, fallbackAnalyze } from "../services/e1_rspamd/index.js";

// Ensure RSPAMD_URL is unset so analyze() takes the fallback path.
delete process.env.RSPAMD_URL;

function email(overrides = {}) {
  return {
    org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "",
    body_html: null, headers: {}, attachments: [],
    prior_signals: [], ...overrides,
  };
}

test("E1 rspamd: no auth signals when headers are clean (fallback mode)", async () => {
  const signals = await analyze(email());
  assert.equal(signals.length, 0);
});

test("E1 rspamd: fallback fires SPF_FAIL when Authentication-Results says so", async () => {
  const signals = await analyze(email({ headers: { "Authentication-Results": "spf=fail" } }));
  const names = signals.map((s) => s.signal);
  assert.ok(names.includes("SPF_FAIL"));
});

test("E1 rspamd: fallback fires DMARC_POLICY_REJECT on dmarc=fail", async () => {
  const signals = await analyze(email({ headers: { "Authentication-Results": "dmarc=fail" } }));
  assert.ok(signals.map((s) => s.signal).includes("DMARC_POLICY_REJECT"));
});

test("E1 rspamd: both fallback signals fire when both fail", async () => {
  const signals = await analyze(email({ headers: { "Authentication-Results": "spf=fail dmarc=fail" } }));
  const names = signals.map((s) => s.signal).sort();
  assert.deepEqual(names, ["DMARC_POLICY_REJECT", "SPF_FAIL"]);
  const total = signals.reduce((a, s) => a + s.score, 0);
  assert.equal(total, 7.5);
});

// ── buildMime: ensures the translator produces well-formed MIME ────────

test("E1 buildMime: includes core RFC-5322 headers", () => {
  const mime = buildMime(email({ subject: "hi", body_text: "hello" }));
  assert.match(mime, /^From: a@b\.com/m);
  assert.match(mime, /^To: c@d\.com/m);
  assert.match(mime, /^Subject: hi/m);
  assert.match(mime, /^Message-ID: m/m);
  assert.match(mime, /^Date:/m);
  assert.match(mime, /hello/);
});

test("E1 buildMime: preserves extra headers from the email.headers map", () => {
  const mime = buildMime(email({
    headers: { "X-Originating-IP": "1.2.3.4", "Received": "from foo" },
  }));
  assert.match(mime, /^X-Originating-IP: 1\.2\.3\.4/m);
  assert.match(mime, /^Received: from foo/m);
});

test("E1 buildMime: html body uses multipart/alternative", () => {
  const mime = buildMime(email({
    body_text: "plain", body_html: "<p>html</p>",
  }));
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain/);
  assert.match(mime, /Content-Type: text\/html/);
  assert.match(mime, /<p>html<\/p>/);
});

// ── rspamdToSignals: translates rspamd JSON → Signal[] ─────────────────

test("E1 rspamdToSignals: maps non-zero symbols to signals", () => {
  const resp = {
    score: 8.5, action: "reject",
    symbols: {
      R_SPF_FAIL: { score: 2.0, description: "SPF failed" },
      DMARC_POLICY_REJECT: { score: 3.0, description: "DMARC reject" },
      BAYES_SPAM: { score: 0, description: "" },
      ZERO_SCORE: { score: 0, description: "" },
    },
  };
  const signals = rspamdToSignals(resp);
  const byName = Object.fromEntries(signals.map((s) => [s.signal, s]));
  assert.equal(byName.R_SPF_FAIL.score, 2.0);
  assert.equal(byName.DMARC_POLICY_REJECT.score, 3.0);
  assert.ok(byName.BAYES_SPAM, "BAYES_SPAM is retained even at score 0");
  assert.equal(byName.ZERO_SCORE, undefined, "generic zero-score symbols dropped");
});

test("E1 rspamdToSignals: emits ACTION_* when rspamd returns a reject action", () => {
  const signals = rspamdToSignals({ score: 15, action: "reject", symbols: {} });
  const a = signals.find((s) => s.signal.startsWith("ACTION_"));
  assert.ok(a);
  assert.equal(a.signal, "ACTION_REJECT");
  assert.equal(a.detail.total_score, 15);
});

test("E1 fallbackAnalyze: degrades gracefully without env or rspamd", () => {
  const s = fallbackAnalyze(email({ headers: { "Authentication-Results": "dmarc=fail" } }));
  assert.ok(s.some((x) => x.signal === "DMARC_POLICY_REJECT"));
});
