import test from "node:test";
import assert from "node:assert/strict";
import { synthesize } from "../services/synthesizer/index.js";

test("synthesize: no signals → allow/ham", () => {
  const v = synthesize([]);
  assert.equal(v.verdict, "allow");
  assert.equal(v.label, "ham");
  assert.equal(v.threat_score, 0);
  assert.equal(v.confidence, 0);
});

test("synthesize: mid score → quarantine/spam", () => {
  const v = synthesize([{ score: 9 }]);
  assert.equal(v.verdict, "quarantine");
  assert.equal(v.label, "spam");
});

test("synthesize: high score → block/phishing with capped confidence", () => {
  const v = synthesize([{ score: 20 }]);
  assert.equal(v.verdict, "block");
  assert.equal(v.label, "phishing");
  assert.equal(v.confidence, 1);
});

test("synthesize: output includes signals and placeholder IOCs/pipeline", () => {
  const signals = [{ engine: "x", signal: "y", score: 3 }];
  const v = synthesize(signals);
  assert.deepEqual(v.signals_fired, signals);
  assert.deepEqual(v.iocs, { urls: [], domains: [], ips: [], hashes: [] });
  assert.deepEqual(v.actions_taken, ["allow"]);
  assert.equal(v.metadata.model_version, "synth-stub-0.1");
});
