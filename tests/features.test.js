import test from "node:test";
import assert from "node:assert/strict";
import { signalsToFeatures, FEATURE_NAMES, featureIndex } from "../shared/features.js";

test("FEATURE_NAMES: stable, non-empty, unique", () => {
  assert.ok(FEATURE_NAMES.length >= 40);
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length);
});

test("signalsToFeatures: empty signals → zero vector", () => {
  const v = signalsToFeatures([]);
  assert.equal(v.length, FEATURE_NAMES.length);
  assert.ok(v.every((x) => x === 0));
});

test("signalsToFeatures: rspamd DMARC_POLICY_REJECT flips rspamd_dmarc_reject", () => {
  const v = signalsToFeatures([
    { engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3 },
  ]);
  assert.equal(v[featureIndex("rspamd_dmarc_reject")], 1);
});

test("signalsToFeatures: multiple signals flip multiple features", () => {
  const v = signalsToFeatures([
    { engine: "rspamd", signal: "SPF_FAIL", score: 2 },
    { engine: "slm", signal: "URGENCY_LANGUAGE", score: 1.5 },
    { engine: "stats_db", signal: "first_time_sender", score: 1.5 },
    { engine: "attachment", signal: "dangerous_extension", score: 4 },
  ]);
  assert.equal(v[featureIndex("rspamd_spf_fail")], 1);
  assert.equal(v[featureIndex("slm_urgency")], 1);
  assert.equal(v[featureIndex("sdb_first_time_sender")], 1);
  assert.equal(v[featureIndex("att_dangerous")], 1);
});

test("signalsToFeatures: unknown engine.signal leaves vector alone", () => {
  const v = signalsToFeatures([{ engine: "unknown", signal: "X", score: 1 }]);
  assert.ok(v.every((x) => x === 0));
});

test("signalsToFeatures: url_scanner.suspicious_tld → url_suspicious_tld", () => {
  const v = signalsToFeatures([
    { engine: "url_scanner", signal: "suspicious_tld", score: 2 },
  ]);
  assert.equal(v[featureIndex("url_suspicious_tld")], 1);
});

test("signalsToFeatures: specialized_ml.mixed_script_domain → sml_mixed_script", () => {
  const v = signalsToFeatures([
    { engine: "specialized_ml", signal: "mixed_script_domain", score: 3 },
  ]);
  assert.equal(v[featureIndex("sml_mixed_script")], 1);
});
