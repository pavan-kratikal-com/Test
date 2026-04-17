import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e2_slm/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E2 SLM: clean body produces no signals", () => {
  assert.equal(analyze(email()).length, 0);
});

test("E2 SLM: URGENCY_LANGUAGE fires with score proportional to token count", () => {
  const s = analyze(email({ subject: "URGENT", body_text: "wire transfer asap" }));
  const u = s.find((x) => x.signal === "URGENCY_LANGUAGE");
  assert.ok(u);
  assert.equal(u.score, 1.5 * 3); // urgent + wire transfer + asap
  assert.deepEqual(u.detail.tokens.sort(), ["asap", "urgent", "wire transfer"]);
});

test("E2 SLM: RSPAMD_REASONED_PHISH requires BOTH urgency and auth-fail prior", () => {
  const onlyUrgency = analyze(email({ body_text: "urgent: asap" }));
  assert.equal(onlyUrgency.find((x) => x.signal === "RSPAMD_REASONED_PHISH"), undefined);

  const onlyAuth = analyze(email({
    prior_signals: [{ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 }],
  }));
  assert.equal(onlyAuth.find((x) => x.signal === "RSPAMD_REASONED_PHISH"), undefined);

  const both = analyze(email({
    body_text: "urgent",
    prior_signals: [{ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 }],
  }));
  const r = both.find((x) => x.signal === "RSPAMD_REASONED_PHISH");
  assert.ok(r);
  assert.equal(r.score, 3);
  assert.deepEqual(r.detail.auth_signals, ["DMARC_POLICY_REJECT"]);
});
