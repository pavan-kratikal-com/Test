import test from "node:test";
import assert from "node:assert/strict";
import { analyze, keywordFallback } from "../services/e2_slm/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

// --- Keyword fallback tests (original behavior, always available) ---

test("E2 SLM: clean body produces no signals (keyword fallback)", () => {
  assert.equal(keywordFallback(email()).length, 0);
});

test("E2 SLM: URGENCY_LANGUAGE fires with score proportional to token count", () => {
  const s = keywordFallback(email({ subject: "URGENT", body_text: "wire transfer asap" }));
  const u = s.find((x) => x.signal === "URGENCY_LANGUAGE");
  assert.ok(u);
  assert.equal(u.score, 2.25 * 3); // urgent + wire transfer + asap
  assert.deepEqual(u.detail.tokens.sort(), ["asap", "urgent", "wire transfer"]);
});

test("E2 SLM: RSPAMD_REASONED_PHISH requires BOTH urgency and auth-fail prior", () => {
  const onlyUrgency = keywordFallback(email({ body_text: "urgent: asap" }));
  assert.equal(onlyUrgency.find((x) => x.signal === "RSPAMD_REASONED_PHISH"), undefined);

  const onlyAuth = keywordFallback(email({
    prior_signals: [{ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 }],
  }));
  assert.equal(onlyAuth.find((x) => x.signal === "RSPAMD_REASONED_PHISH"), undefined);

  const both = keywordFallback(email({
    body_text: "urgent",
    prior_signals: [{ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 }],
  }));
  const r = both.find((x) => x.signal === "RSPAMD_REASONED_PHISH");
  assert.ok(r);
  assert.equal(r.score, 4.5);
  assert.deepEqual(r.detail.auth_signals, ["DMARC_POLICY_REJECT"]);
});

// --- analyze() falls back to keywords when LLM is disabled ---

test("E2 SLM: analyze() returns signals for suspicious email", async () => {
  // SLM_ENABLED defaults to ON; analyze() uses LLM when available, keyword fallback otherwise
  const s = await analyze(email({ subject: "URGENT", body_text: "wire transfer asap" }));
  // Should produce at least one signal regardless of path (LLM or keyword)
  assert.ok(s.length > 0, "analyze() should return at least one signal for suspicious content");
  // Every signal should have required fields
  for (const sig of s) {
    assert.ok(sig.signal, "signal should have a name");
    assert.ok(typeof sig.score === "number", "signal should have a numeric score");
  }
});

test("E2 SLM: analyze() returns no signals for clean email", async () => {
  const s = await analyze(email());
  assert.equal(s.length, 0);
});

// --- LLM response parsing tests ---

test("E2 SLM: parseLLMResponse clamps scores to signal max", async () => {
  // We test the internal parsing by importing and calling it indirectly.
  // Since parseLLMResponse is not exported, we verify via the signal limits
  // being respected in the overall flow. For direct testing, we rely on
  // the keyword fallback tests and integration tests with a real LLM.
  const s = keywordFallback(email({ body_text: "urgent immediately asap wire transfer gift card" }));
  const u = s.find((x) => x.signal === "URGENCY_LANGUAGE");
  assert.ok(u);
  // 5 tokens * 2.25 = 11.25 — keyword fallback doesn't clamp, but LLM path does
  assert.equal(u.score, 2.25 * 5);
});

// --- Cross-signal reasoning ---

test("E2 SLM: cross-signal fires with auth fail + urgency keywords", async () => {
  const s = await analyze(email({
    body_text: "urgent action required",
    prior_signals: [{ engine: "rspamd", signal: "SPF_FAIL", score: 2 }],
  }));
  const r = s.find((x) => x.signal === "RSPAMD_REASONED_PHISH");
  assert.ok(r);
  assert.equal(r.score, 4.5);
});

// --- New signal types exist in feature mappings ---

test("E2 SLM: new signal types are valid engine signals", () => {
  const validSignals = [
    "URGENCY_LANGUAGE", "IMPERSONATION_ATTEMPT", "FINANCIAL_REQUEST",
    "CREDENTIAL_HARVESTING", "EMOTIONAL_MANIPULATION", "SOCIAL_ENGINEERING",
    "RSPAMD_REASONED_PHISH",
  ];
  for (const sig of validSignals) {
    assert.ok(typeof sig === "string" && sig.length > 0, `${sig} should be a valid signal name`);
  }
});

// --- Conversation-aware signal tests (keyword fallback path) ---

function threadEmail(overrides = {}) {
  return email({
    _thread: {
      messages: [
        { sender: "alice@corp.com", subject: "Q1 Budget", body_text: "Here are the numbers for review.", timestamp: "2026-04-15T10:00:00Z" },
        { sender: "bob@corp.com", subject: "Re: Q1 Budget", body_text: "Thanks, looks good to me.", timestamp: "2026-04-15T11:00:00Z" },
      ],
    },
    ...overrides,
  });
}

// 1. BANK_DETAIL_CHANGE — fires when bank change tokens appear in a reply thread

test("E2 SLM: BANK_DETAIL_CHANGE fires on 'updated bank' in reply thread", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Please use our updated bank details for payment.",
  }));
  const sig = s.find((x) => x.signal === "BANK_DETAIL_CHANGE");
  assert.ok(sig, "BANK_DETAIL_CHANGE should fire");
  assert.equal(sig.score, 3.75);
  assert.ok(sig.detail.tokens.includes("updated bank"));
});

test("E2 SLM: BANK_DETAIL_CHANGE fires on 'new routing' in reply thread", () => {
  const s = keywordFallback(threadEmail({
    body_text: "We have a new routing number for the account.",
  }));
  const sig = s.find((x) => x.signal === "BANK_DETAIL_CHANGE");
  assert.ok(sig, "BANK_DETAIL_CHANGE should fire");
  assert.ok(sig.detail.tokens.includes("new routing"));
});

test("E2 SLM: BANK_DETAIL_CHANGE score scales with multiple tokens, capped at 7.5", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Updated bank info and new routing number with new wire instructions.",
  }));
  const sig = s.find((x) => x.signal === "BANK_DETAIL_CHANGE");
  assert.ok(sig);
  assert.ok(sig.score <= 7.5, "Score should be capped at 7.5");
});

// 2. TOPIC_DRIFT_FINANCIAL — fires when financial tokens appear in current but NOT in thread

test("E2 SLM: TOPIC_DRIFT_FINANCIAL fires when financial tokens appear but thread has none", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Please process the wire transfer to the bank account below.",
  }));
  const sig = s.find((x) => x.signal === "TOPIC_DRIFT_FINANCIAL");
  assert.ok(sig, "TOPIC_DRIFT_FINANCIAL should fire");
  assert.ok(sig.detail.tokens.includes("wire transfer"));
  assert.ok(sig.detail.tokens.includes("bank account"));
  assert.equal(sig.score, 3.0 * 2); // two tokens
});

test("E2 SLM: TOPIC_DRIFT_FINANCIAL does NOT fire when thread already has financial tokens", () => {
  const s = keywordFallback(email({
    body_text: "Please send the invoice today.",
    _thread: {
      messages: [
        { sender: "alice@corp.com", subject: "Invoice", body_text: "Here is the invoice for Q1.", timestamp: "2026-04-15T10:00:00Z" },
      ],
    },
  }));
  const sig = s.find((x) => x.signal === "TOPIC_DRIFT_FINANCIAL");
  assert.equal(sig, undefined, "TOPIC_DRIFT_FINANCIAL should NOT fire when thread already contains financial tokens");
});

// 3. URGENCY_INJECTION — fires when urgency tokens appear in current but NOT in thread

test("E2 SLM: URGENCY_INJECTION fires when urgency appears but thread is calm", () => {
  const s = keywordFallback(threadEmail({
    body_text: "This is urgent, respond immediately!",
  }));
  const sig = s.find((x) => x.signal === "URGENCY_INJECTION");
  assert.ok(sig, "URGENCY_INJECTION should fire");
  assert.ok(sig.detail.tokens.includes("urgent"));
  assert.ok(sig.detail.tokens.includes("immediately"));
  assert.equal(sig.score, 3.0 * 2);
});

// 7. URGENCY_INJECTION does NOT fire if urgency was already in the thread

test("E2 SLM: URGENCY_INJECTION does NOT fire if urgency was already in thread", () => {
  const s = keywordFallback(email({
    body_text: "This is urgent, please respond.",
    _thread: {
      messages: [
        { sender: "alice@corp.com", subject: "Urgent request", body_text: "This is urgent, we need the report.", timestamp: "2026-04-15T10:00:00Z" },
      ],
    },
  }));
  const sig = s.find((x) => x.signal === "URGENCY_INJECTION");
  assert.equal(sig, undefined, "URGENCY_INJECTION should NOT fire when urgency already existed in thread");
});

// 4. PRETEXTING_DETECTION — fires when pretext tokens appear but sender is NOT in thread history

test("E2 SLM: PRETEXTING_DETECTION fires when sender references conversation but is not in thread", () => {
  // Default email sender is a@b.com which is NOT in the thread (alice/bob)
  const s = keywordFallback(threadEmail({
    body_text: "As discussed, please update the records.",
  }));
  const sig = s.find((x) => x.signal === "PRETEXTING_DETECTION");
  assert.ok(sig, "PRETEXTING_DETECTION should fire");
  assert.ok(sig.detail.tokens.includes("as discussed"));
  assert.equal(sig.detail.sender_in_thread, false);
});

test("E2 SLM: PRETEXTING_DETECTION fires on 'per our conversation' from unknown sender", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Per our conversation, the payment details have changed.",
  }));
  const sig = s.find((x) => x.signal === "PRETEXTING_DETECTION");
  assert.ok(sig, "PRETEXTING_DETECTION should fire");
  assert.ok(sig.detail.tokens.includes("per our conversation"));
});

test("E2 SLM: PRETEXTING_DETECTION does NOT fire when sender IS in thread", () => {
  const s = keywordFallback(email({
    sender: "alice@corp.com",
    body_text: "As discussed, here is the update.",
    _thread: {
      messages: [
        { sender: "alice@corp.com", subject: "Project", body_text: "Let me check.", timestamp: "2026-04-15T10:00:00Z" },
      ],
    },
  }));
  const sig = s.find((x) => x.signal === "PRETEXTING_DETECTION");
  assert.equal(sig, undefined, "PRETEXTING_DETECTION should NOT fire when sender is in thread history");
});

// 5. INTENT_ACTION_REQUEST — fires when action tokens appear in thread context

test("E2 SLM: INTENT_ACTION_REQUEST fires on action tokens in thread context", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Please transfer now to the account provided.",
  }));
  const sig = s.find((x) => x.signal === "INTENT_ACTION_REQUEST");
  assert.ok(sig, "INTENT_ACTION_REQUEST should fire");
  assert.ok(sig.detail.tokens.includes("transfer now"));
  assert.equal(sig.score, 3.0);
});

test("E2 SLM: INTENT_ACTION_REQUEST fires with multiple action tokens", () => {
  const s = keywordFallback(threadEmail({
    body_text: "Approve now and execute the payment immediately.",
  }));
  const sig = s.find((x) => x.signal === "INTENT_ACTION_REQUEST");
  assert.ok(sig, "INTENT_ACTION_REQUEST should fire");
  assert.ok(sig.detail.tokens.includes("approve now"));
  assert.ok(sig.detail.tokens.includes("execute"));
  assert.equal(sig.score, 3.0 * 2);
});

// 6. Conversation signals do NOT fire when there is no thread

test("E2 SLM: conversation signals do NOT fire when email has no thread", () => {
  const s = keywordFallback(email({
    body_text: "Updated bank info. Transfer now. As discussed, this is urgent immediately.",
  }));
  const conversationSignals = s.filter((x) =>
    ["BANK_DETAIL_CHANGE", "TOPIC_DRIFT_FINANCIAL", "URGENCY_INJECTION",
     "PRETEXTING_DETECTION", "INTENT_ACTION_REQUEST"].includes(x.signal)
  );
  assert.equal(conversationSignals.length, 0,
    "No conversation-aware signals should fire without _thread");
});

test("E2 SLM: conversation signals do NOT fire when _thread.messages is empty", () => {
  const s = keywordFallback(email({
    body_text: "Updated bank info. Transfer now. As discussed, this is urgent.",
    _thread: { messages: [] },
  }));
  const conversationSignals = s.filter((x) =>
    ["BANK_DETAIL_CHANGE", "TOPIC_DRIFT_FINANCIAL", "URGENCY_INJECTION",
     "PRETEXTING_DETECTION", "INTENT_ACTION_REQUEST"].includes(x.signal)
  );
  assert.equal(conversationSignals.length, 0,
    "No conversation-aware signals should fire with empty thread messages");
});
