import test from "node:test";
import assert from "node:assert/strict";
import { Email, Signal, FinalVerdict, Verdict, Label } from "../shared/schemas.js";

test("Email: valid minimal payload parses", () => {
  const e = Email.parse({
    org_id: "o",
    message_id: "m",
    sender: "a@b.com",
    recipients: ["c@d.com"],
  });
  assert.equal(e.subject, "");
  assert.equal(e.body_text, "");
  assert.deepEqual(e.headers, {});
  assert.deepEqual(e.attachments, []);
  assert.deepEqual(e.prior_signals, []);
});

test("Email: rejects payload missing required fields", () => {
  assert.throws(() => Email.parse({ org_id: "o" }));
  assert.throws(() => Email.parse({ sender: "a@b.com" }));
  assert.throws(() => Email.parse({}));
});

test("Email: accepts prior_signals and org_context", () => {
  const e = Email.parse({
    org_id: "o", message_id: "m", sender: "a@b.com", recipients: ["c@d.com"],
    prior_signals: [{ engine: "rspamd", signal: "SPF_FAIL", score: 2 }],
    org_context: { industry: "banking", thresholds: { block: 6, quarantine: 3 } },
  });
  assert.equal(e.prior_signals.length, 1);
  assert.equal(e.org_context.industry, "banking");
});

test("Signal: defaults score to 0 and detail to {}", () => {
  const s = Signal.parse({ engine: "x", signal: "Y" });
  assert.equal(s.score, 0);
  assert.deepEqual(s.detail, {});
});

test("Verdict enum: accepts allow/quarantine/block, rejects others", () => {
  assert.equal(Verdict.parse("allow"), "allow");
  assert.equal(Verdict.parse("quarantine"), "quarantine");
  assert.equal(Verdict.parse("block"), "block");
  assert.throws(() => Verdict.parse("drop"));
});

test("Label enum: covers full vocabulary", () => {
  for (const l of ["ham", "spam", "marketing", "promotion", "phishing", "bec", "malware", "trash"]) {
    assert.equal(Label.parse(l), l);
  }
  assert.throws(() => Label.parse("unknown"));
});

test("FinalVerdict: minimal valid payload", () => {
  const v = FinalVerdict.parse({
    verdict: "allow", confidence: 0.1, label: "ham",
    threat_score: 1, reason: "ok",
  });
  assert.deepEqual(v.iocs, { urls: [], domains: [], ips: [], hashes: [] });
  assert.deepEqual(v.threats, []);
});
