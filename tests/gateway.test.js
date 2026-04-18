// Gateway unit tests — aggregate() pure logic only. End-to-end orchestration
// is exercised by the smoke/eval scripts against running services.
import test from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../services/gateway/index.js";

const NEUTRAL = { bec: 1, phishing: 1, malware: 1 };
const DEFAULT_THRESH = { block: 15, quarantine: 8 };

test("aggregate: empty signals → allow/ham", () => {
  const r = aggregate([], DEFAULT_THRESH, NEUTRAL);
  assert.equal(r.verdict, "allow");
  assert.equal(r.label, "ham");
  assert.equal(r.total, 0);
});

test("aggregate: score below quarantine threshold → allow", () => {
  const r = aggregate([{ signal: "x", score: 3 }], DEFAULT_THRESH, NEUTRAL);
  assert.equal(r.verdict, "allow");
  assert.equal(r.total, 3);
});

test("aggregate: score in quarantine band → quarantine/spam", () => {
  const r = aggregate([{ signal: "x", score: 9 }], DEFAULT_THRESH, NEUTRAL);
  assert.equal(r.verdict, "quarantine");
  assert.equal(r.label, "spam");
});

test("aggregate: score at or above block threshold → block/phishing", () => {
  const r = aggregate([{ signal: "x", score: 15 }], DEFAULT_THRESH, NEUTRAL);
  assert.equal(r.verdict, "block");
  assert.equal(r.label, "phishing");
});

test("aggregate: honors custom thresholds (banking)", () => {
  const strict = { block: 6, quarantine: 3 };
  assert.equal(aggregate([{ signal: "x", score: 7 }], strict, NEUTRAL).verdict, "block");
  assert.equal(aggregate([{ signal: "x", score: 4 }], strict, NEUTRAL).verdict, "quarantine");
  assert.equal(aggregate([{ signal: "x", score: 2 }], strict, NEUTRAL).verdict, "allow");
});

test("aggregate: industry BEC weight scales 'wire transfer' signals", () => {
  const bec = { bec: 2, phishing: 1, malware: 1 };
  const r = aggregate(
    [{ signal: "URGENCY_LANGUAGE", score: 6 }, { signal: "wire_transfer_intent", score: 2 }],
    DEFAULT_THRESH, bec,
  );
  // URGENCY_LANGUAGE matches BEC regex (urgency), wire_transfer_intent matches "wire".
  // Total: 6*2 + 2*2 = 16
  assert.equal(r.total, 16);
  assert.equal(r.verdict, "block");
});

test("aggregate: phishing signals scaled by industry phishing_weight", () => {
  const heavyPhishing = { bec: 1, phishing: 2, malware: 1 };
  const r = aggregate(
    [{ signal: "DMARC_POLICY_REJECT", score: 4.5 },
     { signal: "credential_form_detected", score: 4.5 }],
    DEFAULT_THRESH, heavyPhishing,
  );
  // Both match phishing regex (DMARC, credential). Total: 4.5*2 + 4.5*2 = 18
  assert.equal(r.total, 18);
  assert.equal(r.verdict, "block");
});

test("aggregate: malware signals scaled by malware_weight", () => {
  const heavyMalware = { bec: 1, phishing: 1, malware: 3 };
  const r = aggregate(
    [{ signal: "dangerous_extension", score: 6 }],
    DEFAULT_THRESH, heavyMalware,
  );
  assert.equal(r.total, 18);
  assert.equal(r.verdict, "block");
});

test("aggregate: reason string includes score and threshold", () => {
  const r = aggregate([{ signal: "x", score: 15 }], DEFAULT_THRESH, NEUTRAL);
  assert.match(r.reason, /15\.0/);
  assert.match(r.reason, /block threshold 15/);
});
