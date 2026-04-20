#!/usr/bin/env node
// Benchmark runner — sends labeled emails through the gateway and measures:
//   1. Classification accuracy (verdict vs ground-truth label)
//   2. Signal/feature coverage (which fire, which never fire)
//   3. Latency distribution (p50, p95, p99, avg)
//   4. Per-engine timing breakdown
//
// Usage:
//   node bin/benchmark.js [path-to-jsonl] [--concurrency N] [--gateway URL]
//   node bin/benchmark.js --eml-dir=/path/to/eml [--warmup] [--gateway URL]
//
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { FEATURE_NAMES } from "../shared/features.js";
import { signalsToFeatures } from "../shared/features.js";

const EML_DIR = process.argv.find(a => a.startsWith("--eml-dir="))?.split("=")[1] || "";
const WARMUP = process.argv.includes("--warmup");
const JSONL_PATH = !EML_DIR ? (process.argv[2] || "/Users/kratikal/spam-classifier/data/labeled_emails.jsonl") : "";
const CONCURRENCY = Number(process.argv.find(a => a.startsWith("--concurrency="))?.split("=")[1] || 3);
const GATEWAY = process.argv.find(a => a.startsWith("--gateway="))?.split("=")[1] || "http://localhost:8000";
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || 0);
const AUTH_EMAIL = process.argv.find(a => a.startsWith("--email="))?.split("=")[1] || "bench@test.com";
const AUTH_PASS = process.argv.find(a => a.startsWith("--password="))?.split("=")[1] || "BenchTest1";
const ORG_ID = process.argv.find(a => a.startsWith("--org="))?.split("=")[1] || "kratikal";

// Auth token — set during login
let AUTH_TOKEN = "";

// EML subdir name → expected verdict
const EML_LABEL_MAP = {
  ham: "allow",
  marketing: "allow",
  promotion: "allow",
  spam: "quarantine",
  trash: "quarantine",
  phishing: "block",
  bec: "block",
  malware: "block",
};

// ─── Label mapping: JSONL labels → our verdict expectations ─────────────
// Our system outputs: allow / quarantine / block
// Ground truth labels: ham, spam, cold_email, transactional, promotional, updates, forum, social
const LABEL_TO_EXPECTED_VERDICT = {
  ham:           "allow",
  transactional: "allow",
  updates:       "allow",
  forum:         "allow",
  social:        "allow",
  promotional:   "allow",      // borderline — some orgs quarantine
  marketing:     "allow",      // EML dir label
  promotion:     "allow",      // EML dir label
  cold_email:    "quarantine",  // unsolicited but not malicious
  spam:          "quarantine",  // should be caught
  trash:         "quarantine",  // EML dir label
  phishing:      "block",
  bec:           "block",
  malware:       "block",
};

// Verdict severity ordering for "at least as severe" matching
const VERDICT_RANK = { allow: 0, quarantine: 1, block: 2 };

// ─── Convert JSONL email to gateway schema ──────────────────────────────
function toGatewayEmail(row) {
  // Parse sender: "Name <email>" or just "email"
  let senderEmail = row.sender || "";
  const angleMatch = senderEmail.match(/<([^>]+)>/);
  if (angleMatch) senderEmail = angleMatch[1];

  // Decode HTML entities in snippet
  const body = (row.snippet || "")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  return {
    org_id: ORG_ID,
    message_id: row.id || `bench-${Math.random().toString(36).slice(2)}`,
    sender: row.sender || "",
    recipients: row.toRecipients || ["benchmark@test.com"],
    subject: row.subject || "",
    body_text: body,
    body_html: null,
    headers: {},
    attachments: [],
    received_at: row.date || new Date().toISOString(),
  };
}

// ─── Login to get JWT token ──────────────────────────────────────────────
async function login() {
  const res = await fetch(`${GATEWAY}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASS }),
  });
  if (!res.ok) {
    // Try registering first
    const regRes = await fetch(`${GATEWAY}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASS, name: "Benchmark" }),
    });
    if (!regRes.ok) throw new Error(`Login failed and registration failed: ${await regRes.text()}`);
    // Login after registration
    const res2 = await fetch(`${GATEWAY}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASS }),
    });
    if (!res2.ok) throw new Error(`Login failed after registration: ${await res2.text()}`);
    const cookies = res2.headers.getSetCookie?.() || [];
    AUTH_TOKEN = extractToken(cookies);
    return;
  }
  const cookies = res.headers.getSetCookie?.() || [];
  AUTH_TOKEN = extractToken(cookies);
}

function extractToken(cookies) {
  for (const c of cookies) {
    const m = c.match(/access_token=([^;]+)/);
    if (m) return m[1];
  }
  return "";
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (AUTH_TOKEN) h["Cookie"] = `access_token=${AUTH_TOKEN}`;
  return h;
}

// ─── Send one email and collect metrics ─────────────────────────────────
async function analyzeOne(row) {
  const payload = toGatewayEmail(row);
  const start = performance.now();

  try {
    const res = await fetch(`${GATEWAY}/v1/analyze`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });

    const latency = performance.now() - start;

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { row, error: `HTTP ${res.status}: ${errText.slice(0, 200)}`, latency };
    }

    const result = await res.json();
    return { row, result, latency };
  } catch (err) {
    return { row, error: err.message, latency: performance.now() - start };
  }
}

// ─── Send one EML file and collect metrics ────────────────────────────────
async function analyzeOneEml(item) {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/analyze/eml`, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "message/rfc822",
        "x-org-id": ORG_ID,
      }),
      body: item.rawMime,
      signal: AbortSignal.timeout(60000),
    });

    const latency = performance.now() - start;

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { row: item, error: `HTTP ${res.status}: ${errText.slice(0, 200)}`, latency };
    }

    const result = await res.json();
    return { row: item, result, latency };
  } catch (err) {
    return { row: item, error: err.message, latency: performance.now() - start };
  }
}

// ─── Load EML files from directory ──────────────────────────────────────
function loadEmlFiles(emlDir) {
  const items = [];
  const entries = readdirSync(emlDir);
  for (const entry of entries) {
    const subpath = join(emlDir, entry);
    let stat;
    try { stat = statSync(subpath); } catch { continue; }
    if (stat.isDirectory()) {
      const label = entry.toLowerCase();
      const files = readdirSync(subpath).filter(f => f.endsWith(".eml"));
      for (const file of files) {
        const filePath = join(subpath, file);
        const rawMime = readFileSync(filePath, "utf-8");
        items.push({
          label,
          id: basename(file, ".eml"),
          rawMime,
          file: filePath,
        });
      }
    }
  }
  return items;
}

// ─── Run with concurrency limiter ───────────────────────────────────────
async function runPool(items, fn, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      // Progress
      if ((i + 1) % 10 === 0 || i === items.length - 1) {
        process.stdout.write(`\r  Processed ${i + 1}/${items.length}...`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write("\n");
  return results;
}

// ─── Percentile helper ──────────────────────────────────────────────────
function percentile(sorted, p) {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const isEmlMode = !!EML_DIR;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Email Security Benchmark");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:        ${isEmlMode ? "EML" : "JSONL"}`);
  console.log(`  Data:        ${isEmlMode ? EML_DIR : JSONL_PATH}`);
  console.log(`  Gateway:     ${GATEWAY}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (WARMUP) console.log(`  Warmup:      enabled`);
  console.log();

  // Authenticate
  console.log("  Authenticating...");
  await login();
  if (!AUTH_TOKEN) {
    console.error("  ERROR: Failed to obtain auth token. Check credentials.");
    process.exit(1);
  }
  console.log("  Authenticated.\n");

  // Load data
  let rows;
  let analyzeFn;

  if (isEmlMode) {
    rows = loadEmlFiles(EML_DIR);
    analyzeFn = analyzeOneEml;
    console.log(`  Loaded ${rows.length} .eml files\n`);
  } else {
    const lines = readFileSync(JSONL_PATH, "utf-8").trim().split("\n");
    rows = lines.map((l) => JSON.parse(l));
    analyzeFn = analyzeOne;
    console.log(`  Loaded ${rows.length} emails\n`);
  }

  // Apply --limit: proportional sample across labels
  if (LIMIT && LIMIT < rows.length) {
    const byLabel = {};
    for (const r of rows) (byLabel[r.label] ??= []).push(r);
    const total = rows.length;
    rows = [];
    for (const [, items] of Object.entries(byLabel)) {
      const n = Math.max(1, Math.round(items.length / total * LIMIT));
      rows.push(...items.slice(0, n));
    }
    console.log(`  Limited to ${rows.length} emails (proportional sample)\n`);
  }

  // Label distribution
  const labelDist = {};
  for (const r of rows) labelDist[r.label] = (labelDist[r.label] || 0) + 1;
  console.log("  Label distribution:");
  for (const [label, count] of Object.entries(labelDist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(15)} ${count}`);
  }
  console.log();

  // When --warmup is set, split data: first 30% for warmup, remaining 70% for benchmark.
  // This avoids measuring on the same data used to build baselines.
  let benchRows = rows;
  if (WARMUP) {
    // Group by label, take first 30% of each for warmup to keep label ratios balanced
    const byLabel = {};
    for (const r of rows) {
      (byLabel[r.label] ??= []).push(r);
    }
    const warmupRows = [];
    benchRows = [];
    for (const [label, items] of Object.entries(byLabel)) {
      const split = Math.ceil(items.length * 0.3);
      warmupRows.push(...items.slice(0, split));
      benchRows.push(...items.slice(split));
    }
    console.log(`  Warmup split: ${warmupRows.length} warmup, ${benchRows.length} benchmark\n`);
    console.log("  Warmup pass (building baselines, not measured)...");
    await runPool(warmupRows, analyzeFn, CONCURRENCY);
    console.log("  Warmup complete.\n");

    // Print benchmark label distribution
    const benchDist = {};
    for (const r of benchRows) benchDist[r.label] = (benchDist[r.label] || 0) + 1;
    console.log("  Benchmark label distribution:");
    for (const [label, count] of Object.entries(benchDist).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${label.padEnd(15)} ${count}`);
    }
    console.log();
  }

  // Run benchmark
  console.log("  Sending emails through gateway...");
  const results = await runPool(benchRows, analyzeFn, CONCURRENCY);

  // ─── Collect metrics ────────────────────────────────────────────────
  const errors = results.filter((r) => r.error);
  const ok = results.filter((r) => r.result);

  const latencies = ok.map((r) => r.latency).sort((a, b) => a - b);
  const signalCounts = {};      // signal_name → fire count
  const engineCounts = {};      // engine → fire count
  const featureHits = new Array(FEATURE_NAMES.length).fill(0);
  const confusionMatrix = {};   // {expected}_{actual} → count

  let correct = 0;
  let correctStrict = 0;
  let total = 0;

  // Per-label accuracy
  const perLabel = {};  // label → { total, correct, correctStrict }

  for (const r of ok) {
    total++;
    const gtLabel = r.row.label;
    const expectedVerdict = LABEL_TO_EXPECTED_VERDICT[gtLabel] || "allow";
    const actualVerdict = r.result.verdict;
    const signals = r.result.signals_fired || [];

    // Confusion matrix
    const key = `${expectedVerdict}_${actualVerdict}`;
    confusionMatrix[key] = (confusionMatrix[key] || 0) + 1;

    // Strict match
    if (actualVerdict === expectedVerdict) correctStrict++;

    // Relaxed match: quarantine for expected-block is acceptable,
    // and quarantine for expected-allow is a soft miss (conservative)
    const actualRank = VERDICT_RANK[actualVerdict] ?? 0;
    const expectedRank = VERDICT_RANK[expectedVerdict] ?? 0;
    // Correct if: exact match, or system is MORE strict (acceptable false positive)
    if (actualVerdict === expectedVerdict || actualRank >= expectedRank) correct++;

    // Per-label tracking
    if (!perLabel[gtLabel]) perLabel[gtLabel] = { total: 0, correct: 0, correctStrict: 0, verdicts: {} };
    perLabel[gtLabel].total++;
    if (actualVerdict === expectedVerdict) perLabel[gtLabel].correctStrict++;
    if (actualVerdict === expectedVerdict || actualRank >= expectedRank) perLabel[gtLabel].correct++;
    perLabel[gtLabel].verdicts[actualVerdict] = (perLabel[gtLabel].verdicts[actualVerdict] || 0) + 1;

    // Signal coverage
    for (const s of signals) {
      const sigKey = `${s.engine}.${s.signal}`;
      signalCounts[sigKey] = (signalCounts[sigKey] || 0) + 1;
      engineCounts[s.engine] = (engineCounts[s.engine] || 0) + 1;
    }

    // Feature vector coverage
    const vec = signalsToFeatures(signals);
    for (let i = 0; i < vec.length; i++) {
      if (vec[i]) featureHits[i]++;
    }
  }

  // ─── Print Results ──────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  1. CLASSIFICATION ACCURACY");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log(`  Emails processed: ${total}  (errors: ${errors.length})`);
  console.log(`  Strict accuracy:  ${correctStrict}/${total} (${(correctStrict / total * 100).toFixed(1)}%)`);
  console.log(`  Relaxed accuracy: ${correct}/${total} (${(correct / total * 100).toFixed(1)}%)`);
  console.log(`    (relaxed = system at-least-as-strict counts as correct)\n`);

  // Confusion matrix
  console.log("  Confusion Matrix (expected → actual):");
  console.log("  ┌─────────────┬─────────┬────────────┬─────────┐");
  console.log("  │ expected \\   │  allow  │ quarantine │  block  │");
  console.log("  ├─────────────┼─────────┼────────────┼─────────┤");
  for (const exp of ["allow", "quarantine", "block"]) {
    const a = confusionMatrix[`${exp}_allow`] || 0;
    const q = confusionMatrix[`${exp}_quarantine`] || 0;
    const b = confusionMatrix[`${exp}_block`] || 0;
    console.log(`  │ ${exp.padEnd(11)} │ ${String(a).padStart(7)} │ ${String(q).padStart(10)} │ ${String(b).padStart(7)} │`);
  }
  console.log("  └─────────────┴─────────┴────────────┴─────────┘\n");

  // Per-label breakdown
  console.log("  Per-label breakdown:");
  console.log("  ┌─────────────────┬───────┬──────────┬──────────────────────────┐");
  console.log("  │ Label           │ Count │ Accuracy │ Verdict Distribution     │");
  console.log("  ├─────────────────┼───────┼──────────┼──────────────────────────┤");
  for (const [label, data] of Object.entries(perLabel).sort((a, b) => b[1].total - a[1].total)) {
    const acc = `${(data.correctStrict / data.total * 100).toFixed(0)}%`;
    const vDist = Object.entries(data.verdicts)
      .sort((a, b) => b[1] - a[1])
      .map(([v, c]) => `${v}:${c}`)
      .join(" ");
    console.log(`  │ ${label.padEnd(15)} │ ${String(data.total).padStart(5)} │ ${acc.padStart(8)} │ ${vDist.padEnd(24)} │`);
  }
  console.log("  └─────────────────┴───────┴──────────┴──────────────────────────┘\n");

  // ─── Latency ────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  2. LATENCY (per email)");
  console.log("═══════════════════════════════════════════════════════════\n");

  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`  Total emails:  ${latencies.length}`);
    console.log(`  Average:       ${avg.toFixed(0)}ms`);
    console.log(`  Median (p50):  ${percentile(latencies, 50).toFixed(0)}ms`);
    console.log(`  p90:           ${percentile(latencies, 90).toFixed(0)}ms`);
    console.log(`  p95:           ${percentile(latencies, 95).toFixed(0)}ms`);
    console.log(`  p99:           ${percentile(latencies, 99).toFixed(0)}ms`);
    console.log(`  Min:           ${latencies[0].toFixed(0)}ms`);
    console.log(`  Max:           ${latencies[latencies.length - 1].toFixed(0)}ms`);
    console.log(`  Total time:    ${(latencies.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);
    console.log(`  Wall clock:    ${((latencies[latencies.length - 1] > 0 ? results.reduce((acc, r) => acc + r.latency, 0) : 0) / 1000 / CONCURRENCY).toFixed(1)}s (est. at concurrency=${CONCURRENCY})`);
  }

  // ─── Engine usage ───────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  3. ENGINE USAGE (signals fired per engine)");
  console.log("═══════════════════════════════════════════════════════════\n");

  for (const [engine, count] of Object.entries(engineCounts).sort((a, b) => b[1] - a[1])) {
    const pct = (count / total * 100).toFixed(1);
    const bar = "█".repeat(Math.round(count / total * 40));
    console.log(`  ${engine.padEnd(18)} ${String(count).padStart(5)} signals  (${pct.padStart(5)}% of emails)  ${bar}`);
  }

  // ─── Signal coverage ───────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  4. SIGNAL COVERAGE (top signals that fired)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const sortedSignals = Object.entries(signalCounts).sort((a, b) => b[1] - a[1]);
  const topN = 30;
  console.log(`  Top ${topN} signals:`);
  for (const [sig, count] of sortedSignals.slice(0, topN)) {
    const pct = (count / total * 100).toFixed(1);
    const bar = "█".repeat(Math.min(Math.round(count / total * 50), 50));
    console.log(`    ${sig.padEnd(45)} ${String(count).padStart(4)}  (${pct.padStart(5)}%)  ${bar}`);
  }
  if (sortedSignals.length > topN) {
    console.log(`    ... and ${sortedSignals.length - topN} more signals`);
  }

  // ─── Feature vector coverage ────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  5. FEATURE VECTOR COVERAGE");
  console.log("═══════════════════════════════════════════════════════════\n");

  const activeFeatures = featureHits.filter((h) => h > 0).length;
  const totalFeatures = FEATURE_NAMES.length;
  console.log(`  Active features: ${activeFeatures}/${totalFeatures} (${(activeFeatures / totalFeatures * 100).toFixed(1)}%)`);
  console.log(`  Dead features:   ${totalFeatures - activeFeatures} (never fired)\n`);

  // Active features
  console.log("  Active features:");
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    if (featureHits[i] > 0) {
      const pct = (featureHits[i] / total * 100).toFixed(1);
      console.log(`    [${String(i).padStart(3)}] ${FEATURE_NAMES[i].padEnd(35)} ${String(featureHits[i]).padStart(4)} emails (${pct.padStart(5)}%)`);
    }
  }

  // Dead features
  console.log("\n  Dead features (never fired):");
  const deadFeatures = [];
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    if (featureHits[i] === 0) deadFeatures.push(FEATURE_NAMES[i]);
  }
  // Group by prefix
  const deadByPrefix = {};
  for (const f of deadFeatures) {
    const prefix = f.split("_")[0];
    if (!deadByPrefix[prefix]) deadByPrefix[prefix] = [];
    deadByPrefix[prefix].push(f);
  }
  for (const [prefix, features] of Object.entries(deadByPrefix)) {
    console.log(`    ${prefix}: ${features.join(", ")}`);
  }

  // ─── Cost estimation ───────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  6. COMPUTE COST ESTIMATE (per email)");
  console.log("═══════════════════════════════════════════════════════════\n");

  if (latencies.length > 0) {
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const avgSignals = ok.reduce((sum, r) => sum + (r.result.signals_fired?.length || 0), 0) / ok.length;

    // Estimate SLM token cost from signals
    const slmSignals = ok.filter((r) => (r.result.signals_fired || []).some((s) => s.engine === "slm"));
    const slmPct = (slmSignals.length / ok.length * 100).toFixed(1);

    console.log("  Per-email averages:");
    console.log(`    Latency:          ${avgLatency.toFixed(0)}ms`);
    console.log(`    Signals fired:    ${avgSignals.toFixed(1)}`);
    console.log(`    SLM invoked:      ${slmPct}% of emails`);
    console.log();
    console.log("  Throughput at current performance:");
    console.log(`    Sequential:       ${(1000 / avgLatency).toFixed(1)} emails/sec`);
    console.log(`    Concurrent (×${CONCURRENCY}):   ${(1000 / avgLatency * CONCURRENCY).toFixed(1)} emails/sec`);
    console.log(`    Daily capacity:   ${Math.round(1000 / avgLatency * CONCURRENCY * 86400).toLocaleString()} emails/day`);
    console.log();

    // Estimated SLM token usage
    // Prompt is ~400-800 tokens, response ~50-200 tokens
    const avgPromptTokens = 600;
    const avgCompletionTokens = 100;
    console.log("  SLM token estimate (per email with SLM):");
    console.log(`    Prompt tokens:    ~${avgPromptTokens}`);
    console.log(`    Completion tokens: ~${avgCompletionTokens}`);
    console.log(`    Total:            ~${avgPromptTokens + avgCompletionTokens} tokens`);
    console.log(`    Local inference:  $0.00 (on-device Gemma)`);
  }

  // ─── Errors ─────────────────────────────────────────────────────────
  if (errors.length > 0) {
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  7. ERRORS");
    console.log("═══════════════════════════════════════════════════════════\n");
    const errTypes = {};
    for (const e of errors) {
      const msg = e.error.slice(0, 100);
      errTypes[msg] = (errTypes[msg] || 0) + 1;
    }
    for (const [msg, count] of Object.entries(errTypes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}× ${msg}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Benchmark complete.");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((err) => { console.error(err); process.exit(1); });
