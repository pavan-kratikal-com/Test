#!/usr/bin/env node
// Phase 1 evaluation framework (PRD §14.1 exit criteria).
//
// Usage: node tools/evaluate.js <dataset.jsonl> [--gateway http://127.0.0.1:8000]
//
// Dataset format: one JSON object per line with:
//   { "expected_label": "ham"|"spam"|"phishing", "email": { ...Email schema... } }
//
// Outputs: per-category precision/recall/F1, confusion matrix, overall
// accuracy. Exit code 1 if false-positive rate exceeds 0.5% (PRD target).
import { readFileSync } from "node:fs";
import { request } from "undici";

const args = process.argv.slice(2);
const datasetPath = args[0];
const gatewayIdx = args.indexOf("--gateway");
const gateway = gatewayIdx >= 0 ? args[gatewayIdx + 1] : "http://127.0.0.1:8000";

if (!datasetPath) {
  console.error("usage: evaluate.js <dataset.jsonl> [--gateway URL]");
  process.exit(2);
}

const lines = readFileSync(datasetPath, "utf8").split("\n").filter(Boolean);
const samples = lines.map((l, i) => {
  try { return JSON.parse(l); }
  catch (err) { console.error(`line ${i + 1}: ${err.message}`); process.exit(2); }
});

// Map verdict → label bucket for evaluation.
function toLabel(verdict) {
  if (verdict === "block") return "phishing";
  if (verdict === "quarantine") return "spam";
  return "ham";
}

const LABELS = ["ham", "spam", "phishing"];
const confusion = Object.fromEntries(
  LABELS.map((a) => [a, Object.fromEntries(LABELS.map((b) => [b, 0]))]),
);

let ok = 0;
let fp = 0; let hamTotal = 0;
const failures = [];

for (const s of samples) {
  const r = await request(`${gateway}/v1/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s.email),
  });
  const body = await r.body.json();
  const predicted = toLabel(body.verdict);
  const expected = s.expected_label;
  confusion[expected][predicted] += 1;
  if (predicted === expected) ok += 1;
  else failures.push({
    message_id: s.email.message_id, expected, predicted,
    score: body.threat_score, reason: body.reason,
  });
  if (expected === "ham") {
    hamTotal += 1;
    if (predicted !== "ham") fp += 1;
  }
}

function pr(label) {
  const tp = confusion[label][label];
  const fpCount = LABELS.filter((l) => l !== label).reduce((a, l) => a + confusion[l][label], 0);
  const fn = LABELS.filter((l) => l !== label).reduce((a, l) => a + confusion[label][l], 0);
  const p = tp + fpCount === 0 ? 0 : tp / (tp + fpCount);
  const r = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = p + r === 0 ? 0 : 2 * p * r / (p + r);
  return { precision: p, recall: r, f1, tp, fp: fpCount, fn };
}

console.log(`\n=== Evaluation (${samples.length} samples) ===`);
console.log(`Accuracy: ${(ok / samples.length * 100).toFixed(1)}%`);
console.log(`False positive rate (ham→non-ham): ${hamTotal === 0 ? "n/a" : (fp / hamTotal * 100).toFixed(2)}%`);

console.log(`\nConfusion matrix (rows=expected, cols=predicted):`);
console.log(`           ${LABELS.map((l) => l.padStart(10)).join("")}`);
for (const row of LABELS) {
  console.log(`${row.padStart(10)}  ${LABELS.map((l) => String(confusion[row][l]).padStart(10)).join("")}`);
}

console.log(`\nPer-label metrics:`);
for (const l of LABELS) {
  const m = pr(l);
  console.log(`  ${l.padStart(10)}: P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)}  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`);
}

if (failures.length > 0) {
  console.log(`\nFailures (${failures.length}):`);
  for (const f of failures.slice(0, 10)) {
    console.log(`  ${f.message_id}: expected=${f.expected} predicted=${f.predicted} score=${f.score}`);
  }
}

// Phase 1 FP-rate target: <0.5%
if (hamTotal > 0 && fp / hamTotal > 0.005) {
  console.log(`\nFAIL: false positive rate ${(fp / hamTotal * 100).toFixed(2)}% > 0.5% target`);
  process.exit(1);
}
