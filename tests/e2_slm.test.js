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
  assert.equal(u.score, 1.5 * 3);
});

test("E2 SLM: RSPAMD_REASONED_PHISH requires BOTH urgency and auth-fail prior", () => {
  const onlyUrgency = analyze(email({ body_text: "urgent asap" }));
  assert.equal(onlyUrgency.find((x) => x.signal === "RSPAMD_REASONED_PHISH"), undefined);

  const both = analyze(email({
    body_text: "urgent",
    prior_signals: [{ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 }],
  }));
  const r = both.find((x) => x.signal === "RSPAMD_REASONED_PHISH");
  assert.ok(r);
});

// ── Phase 2 extended cross-signal reasoning ──────────────────────────

test("E2 SLM: NEW_VENDOR_WIRE_REQUEST needs first_time_sender + urgency + payment", () => {
  const s = analyze(email({
    body_text: "urgent wire transfer please",
    prior_signals: [{ engine: "stats_db", signal: "first_time_sender", score: 1.5 }],
  }));
  assert.ok(s.find((x) => x.signal === "NEW_VENDOR_WIRE_REQUEST"));
});

test("E2 SLM: STATS_REASONED_BEC fires on first_time_pair + payment intent", () => {
  const s = analyze(email({
    body_text: "please send wire payment",
    prior_signals: [{ engine: "stats_db", signal: "first_time_pair", score: 0.8 }],
  }));
  assert.ok(s.find((x) => x.signal === "STATS_REASONED_BEC"));
});

test("E2 SLM: YOUNG_DOMAIN_URGENCY fires on domain_first_seen_recent + urgency", () => {
  const s = analyze(email({
    body_text: "urgent please act",
    prior_signals: [{ engine: "stats_db", signal: "domain_first_seen_recent", score: 1 }],
  }));
  assert.ok(s.find((x) => x.signal === "YOUNG_DOMAIN_URGENCY"));
});

test("E2 SLM: FREEMAIL_BEC fires on freemail_to_corp + payment", () => {
  const s = analyze(email({
    body_text: "need wire transfer today",
    prior_signals: [{ engine: "stats_db", signal: "freemail_to_corp", score: 0.6 }],
  }));
  assert.ok(s.find((x) => x.signal === "FREEMAIL_BEC"));
});

test("E2 SLM: EXEC_IMPERSONATION_TEXT fires on VIP match + urgency", () => {
  const s = analyze(email({
    body_text: "urgent please act now",
    prior_signals: [{ engine: "graph_db", signal: "executive_impersonation", score: 2.5 }],
  }));
  assert.ok(s.find((x) => x.signal === "EXEC_IMPERSONATION_TEXT"));
});

test("E2 SLM: GRAPH_REASONED_DIR_REVERSAL fires on direction_reversal + change intent", () => {
  const s = analyze(email({
    body_text: "please update the bank account",
    prior_signals: [{ engine: "graph_db", signal: "direction_reversal", score: 1.8 }],
  }));
  assert.ok(s.find((x) => x.signal === "GRAPH_REASONED_DIR_REVERSAL"));
});

test("E2 SLM: VENDOR_EMAIL_COMPROMISE fires on first_time_external + payment + change", () => {
  const s = analyze(email({
    body_text: "update payment details for next invoice",
    prior_signals: [{ engine: "graph_db", signal: "first_time_external_sender", score: 1.5 }],
  }));
  assert.ok(s.find((x) => x.signal === "VENDOR_EMAIL_COMPROMISE"));
});

test("E2 SLM: no cross-signal fires on ham + no priors", () => {
  const s = analyze(email({ body_text: "hi", prior_signals: [] }));
  const names = s.map((x) => x.signal);
  assert.equal(names.filter((n) => /REASONED|VENDOR|IMPERSONATION/.test(n)).length, 0);
});
