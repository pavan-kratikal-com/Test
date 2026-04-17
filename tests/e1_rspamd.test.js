import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e1_rspamd/index.js";

function email(overrides = {}) {
  return {
    org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "",
    body_html: null, headers: {}, attachments: [],
    prior_signals: [], ...overrides,
  };
}

test("E1 rspamd: no auth signals when headers are clean", () => {
  const signals = analyze(email());
  assert.equal(signals.length, 0);
});

test("E1 rspamd: fires SPF_FAIL when Authentication-Results says so", () => {
  const signals = analyze(email({ headers: { "Authentication-Results": "spf=fail" } }));
  const names = signals.map((s) => s.signal);
  assert.ok(names.includes("SPF_FAIL"));
});

test("E1 rspamd: fires DMARC_POLICY_REJECT on dmarc=fail", () => {
  const signals = analyze(email({ headers: { "Authentication-Results": "dmarc=fail" } }));
  const names = signals.map((s) => s.signal);
  assert.ok(names.includes("DMARC_POLICY_REJECT"));
});

test("E1 rspamd: both signals fire when both fail", () => {
  const signals = analyze(email({ headers: { "Authentication-Results": "spf=fail dmarc=fail" } }));
  const names = signals.map((s) => s.signal).sort();
  assert.deepEqual(names, ["DMARC_POLICY_REJECT", "SPF_FAIL"]);
  const total = signals.reduce((a, s) => a + s.score, 0);
  assert.equal(total, 5);
});
