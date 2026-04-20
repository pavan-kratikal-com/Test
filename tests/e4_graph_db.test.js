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

// ── hierarchy_violation ─────────────────────────────────────────────

test("hierarchy_violation fires when unknown external sender contacts 3+ recipients in large org", () => {
  const s = extractSignals(
    email({ recipients: ["a@d.com", "b@d.com", "c@d.com"] }),
    ctx({ senderNode: null, internalCount: 50, senderClique: [], recipientInbound: 0 }),
  );
  assert.ok(s.some((x) => x.signal === "hierarchy_violation"));
});

test("hierarchy_violation does NOT fire with fewer than 3 recipients", () => {
  const s = extractSignals(
    email({ recipients: ["a@d.com", "b@d.com"] }),
    ctx({ senderNode: null, internalCount: 50, senderClique: [], recipientInbound: 0 }),
  );
  assert.equal(s.some((x) => x.signal === "hierarchy_violation"), false);
});

test("hierarchy_violation does NOT fire for small org (internalCount <= 20)", () => {
  const s = extractSignals(
    email({ recipients: ["a@d.com", "b@d.com", "c@d.com"] }),
    ctx({ senderNode: null, internalCount: 10, senderClique: [], recipientInbound: 0 }),
  );
  assert.equal(s.some((x) => x.signal === "hierarchy_violation"), false);
});

// ── clique_penetration ──────────────────────────────────────────────

test("clique_penetration fires when external sender with no clique reaches high-inbound recipient", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 1, total_received: 0, is_internal: 0,
      first_seen: new Date(), last_seen: new Date() },
    edge: null,
    senderClique: [],
    recipientInbound: 15,
  }));
  assert.ok(s.some((x) => x.signal === "clique_penetration"));
});

test("clique_penetration does NOT fire when recipient has few inbound contacts", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 1, total_received: 0, is_internal: 0,
      first_seen: new Date(), last_seen: new Date() },
    edge: null,
    senderClique: [],
    recipientInbound: 3,
  }));
  assert.equal(s.some((x) => x.signal === "clique_penetration"), false);
});

// ── department_boundary_cross ───────────────────────────────────────

test("department_boundary_cross fires when internal sender with dept contacts new recipient", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 10, total_received: 5, is_internal: 1,
      first_seen: new Date(Date.now() - 90 * 86400000),
      last_seen: new Date(), department: "Engineering" },
    edge: null,
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.ok(s.some((x) => x.signal === "department_boundary_cross"));
});

test("department_boundary_cross does NOT fire when edge exists (known pair)", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 10, total_received: 5, is_internal: 1,
      first_seen: new Date(Date.now() - 90 * 86400000),
      last_seen: new Date(), department: "Engineering" },
    edge: { count: 5, first_seen: new Date(Date.now() - 60 * 86400000),
      last_seen: new Date() },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "department_boundary_cross"), false);
});

test("department_boundary_cross does NOT fire when sender has no department", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 10, total_received: 5, is_internal: 1,
      first_seen: new Date(Date.now() - 90 * 86400000),
      last_seen: new Date() },
    edge: null,
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "department_boundary_cross"), false);
});

// ── org_flow_reversal ───────────────────────────────────────────────

test("org_flow_reversal fires when we send many to sender but they barely email us", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 2, total_received: 20, is_internal: 0,
      first_seen: new Date(Date.now() - 180 * 86400000),
      last_seen: new Date() },
    reciprocal: 15,
    edge: { count: 1, first_seen: new Date(Date.now() - 180 * 86400000),
      last_seen: new Date() },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.ok(s.some((x) => x.signal === "org_flow_reversal"));
});

test("org_flow_reversal does NOT fire when reciprocal is low", () => {
  const s = extractSignals(email(), ctx({
    senderNode: { total_sent: 2, total_received: 3, is_internal: 0,
      first_seen: new Date(Date.now() - 180 * 86400000),
      last_seen: new Date() },
    reciprocal: 3,
    edge: { count: 1, first_seen: new Date(Date.now() - 180 * 86400000),
      last_seen: new Date() },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "org_flow_reversal"), false);
});

// ── relationship_tempo_break ────────────────────────────────────────

test("relationship_tempo_break fires when gap exceeds 3x average and >14 days", () => {
  // 30 messages over 300 days → avg gap = 10 days. Last seen 40 days ago → 4x.
  const s = extractSignals(email(), ctx({
    edge: { count: 30, first_seen: new Date(Date.now() - 300 * 86400000),
      last_seen: new Date(Date.now() - 40 * 86400000) },
    senderNode: { total_sent: 30, total_received: 10, is_internal: 0,
      first_seen: new Date(Date.now() - 300 * 86400000),
      last_seen: new Date(Date.now() - 40 * 86400000) },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.ok(s.some((x) => x.signal === "relationship_tempo_break"));
});

test("relationship_tempo_break does NOT fire when gap is within normal range", () => {
  // 30 messages over 300 days → avg gap ~10 days. Last seen 5 days ago → well within range.
  const s = extractSignals(email(), ctx({
    edge: { count: 30, first_seen: new Date(Date.now() - 300 * 86400000),
      last_seen: new Date(Date.now() - 5 * 86400000) },
    senderNode: { total_sent: 30, total_received: 10, is_internal: 0,
      first_seen: new Date(Date.now() - 300 * 86400000),
      last_seen: new Date(Date.now() - 5 * 86400000) },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "relationship_tempo_break"), false);
});

// ── shadow_hierarchy_deviation ──────────────────────────────────────

test("shadow_hierarchy_deviation fires when external sender claims exec title with low trust", () => {
  const s = extractSignals(email({ sender: "attacker@evil.com" }), ctx({
    sender: "attacker@evil.com",
    display: "VP of Finance",
    senderNode: { total_sent: 1, total_received: 0, is_internal: 0,
      first_seen: new Date(), last_seen: new Date() },
    trust: { trust_score: 0.05, reply_reciprocity: 0, relationship_age_days: 1 },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.ok(s.some((x) => x.signal === "shadow_hierarchy_deviation"));
});

test("shadow_hierarchy_deviation does NOT fire when trust score is above 0.1", () => {
  const s = extractSignals(email({ sender: "exec@partner.com" }), ctx({
    sender: "exec@partner.com",
    display: "CEO Partner Corp",
    senderNode: { total_sent: 50, total_received: 30, is_internal: 0,
      first_seen: new Date(Date.now() - 365 * 86400000),
      last_seen: new Date() },
    trust: { trust_score: 0.8, reply_reciprocity: 0.5, relationship_age_days: 365 },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "shadow_hierarchy_deviation"), false);
});

test("shadow_hierarchy_deviation does NOT fire when display name has no exec title", () => {
  const s = extractSignals(email({ sender: "attacker@evil.com" }), ctx({
    sender: "attacker@evil.com",
    display: "John Smith",
    senderNode: { total_sent: 1, total_received: 0, is_internal: 0,
      first_seen: new Date(), last_seen: new Date() },
    trust: { trust_score: 0.05, reply_reciprocity: 0, relationship_age_days: 1 },
    senderClique: [],
    recipientInbound: 0,
  }));
  assert.equal(s.some((x) => x.signal === "shadow_hierarchy_deviation"), false);
});
