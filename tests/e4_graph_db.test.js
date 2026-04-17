// E4 Graph DB — tests exercise the pure signal-extraction logic with
// hand-built contexts. Live MySQL integration is covered by smoke tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSignals, normName, displayNameFromHeaders, applyWeight,
} from "../services/e4_graph_db/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

function ctx(o = {}) {
  return {
    orgId: "o", sender: "a@b.com", recipient: "c@d.com",
    display: "", normalized: "",
    senderNode: null, edge: null, trust: null,
    internalCount: 0, displayHit: null, last48hBurst: 0, reciprocal: 0,
    ...o,
  };
}

test("normName: lowercases and strips punctuation", () => {
  assert.equal(normName("Alice M. SMITH"), "alice m smith");
  assert.equal(normName(""), "");
});

test("displayNameFromHeaders: extracts quoted display name", () => {
  const d = displayNameFromHeaders(email({
    headers: { From: '"Alice Smith" <alice@example.com>' },
  }));
  assert.equal(d, "Alice Smith");
});

test("displayNameFromHeaders: unquoted display name", () => {
  const d = displayNameFromHeaders(email({
    headers: { From: "Alice Smith <alice@example.com>" },
  }));
  assert.equal(d, "Alice Smith");
});

test("first_time_external_sender fires when sender is unknown external", () => {
  const s = extractSignals(email(), ctx({ senderNode: null }));
  assert.ok(s.some((x) => x.signal === "first_time_external_sender"));
});

test("first_time_external_sender does NOT fire if sender already known", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 5, total_received: 2, is_internal: 0,
      first_seen: new Date(Date.now() - 365 * 86400000),
      last_seen: new Date() },
  }));
  assert.equal(s.some((x) => x.signal === "first_time_external_sender"), false);
});

test("first_time_pair_graph fires when edge is missing", () => {
  const s = extractSignals(email(), ctx({ edge: null }));
  assert.ok(s.some((x) => x.signal === "first_time_pair_graph"));
});

test("direction_reversal fires when recipient normally emails sender", () => {
  const s = extractSignals(email(), ctx({ reciprocal: 8, edge: null }));
  assert.ok(s.some((x) => x.signal === "direction_reversal"));
});

test("young_relationship fires when node was created <7 days ago", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 1, total_received: 0, is_internal: 0,
      first_seen: new Date(Date.now() - 2 * 86400000),
      last_seen: new Date() },
  }));
  assert.ok(s.some((x) => x.signal === "young_relationship"));
});

test("trust_decay_dormant fires when last_seen >90 days ago", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 10, total_received: 5, is_internal: 0,
      first_seen: new Date(Date.now() - 400 * 86400000),
      last_seen: new Date(Date.now() - 120 * 86400000) },
  }));
  assert.ok(s.some((x) => x.signal === "trust_decay_dormant"));
});

test("vip_display_name_mismatch fires when display matches VIP but sender differs", () => {
  const s = extractSignals(email({ sender: "attacker@evil.com" }), ctx({
    sender: "attacker@evil.com",
    display: "CEO Alice", normalized: "ceo alice",
    displayHit: { canonical_address: "alice@acmecorp.com", is_vip: 1 },
  }));
  const names = s.map((x) => x.signal);
  assert.ok(names.includes("vip_display_name_mismatch"));
  assert.ok(names.includes("executive_impersonation"));
});

test("compromised_account_spray fires for internal sender with many recent contacts", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 50, total_received: 20, is_internal: 1,
      first_seen: new Date(Date.now() - 365 * 86400000),
      last_seen: new Date() },
    internalCount: 40,
    last48hBurst: 30,
  }));
  assert.ok(s.some((x) => x.signal === "compromised_account_spray"));
});

test("edge_frequency_acceleration fires for high rate over short age", () => {
  const s = extractSignals(email(), ctx({
    edge: { count: 50, first_seen: new Date(Date.now() - 3 * 86400000),
      last_seen: new Date() },
  }));
  assert.ok(s.some((x) => x.signal === "edge_frequency_acceleration"));
});

test("applyWeight: scales all signal scores; weight >=1 is identity", () => {
  const input = [{ engine: "graph_db", signal: "x", score: 2, detail: {} }];
  assert.equal(applyWeight(input, 1)[0].score, 2);
  assert.equal(applyWeight(input, 0.5)[0].score, 1);
  assert.equal(applyWeight(input, 0)[0].score, 0);
});
