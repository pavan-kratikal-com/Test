#!/usr/bin/env node
// Reads enriched_emails.jsonl, transforms each to ETDP API format, and POSTs to /v1/analyze.
// Usage: node batch_test.js [path-to-jsonl] [max-emails]

import { readFileSync } from "fs";

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:8000";
const file = process.argv[2] || "/Users/kratikal/Downloads/enriched_emails.jsonl";
const maxEmails = Number(process.argv[3]) || 20;  // default 20 emails
const CONCURRENCY = 5;

const lines = readFileSync(file, "utf-8").trim().split("\n");
const emails = lines.slice(0, maxEmails).map((l) => JSON.parse(l));

function extractEmail(raw) {
  // Extract just the email address from "Name <email>" format
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw.trim();
}

function extractRecipients(to, cc) {
  const all = [];
  for (const field of [to, cc]) {
    if (!field) continue;
    // Split on comma but handle quoted names
    const parts = field.split(/,\s*(?=[^,]*(?:<|$))/);
    for (const p of parts) {
      const addr = extractEmail(p);
      if (addr && addr.includes("@")) all.push(addr);
    }
  }
  return all.length > 0 ? all : ["unknown@example.com"];
}

function transform(raw) {
  const sender = extractEmail(raw.from || "");
  const recipients = extractRecipients(raw.to, raw.cc);
  const authResults = raw.security_headers?.["authentication-results"]
    || raw.security_headers?.["received-spf"]
    || "";

  return {
    org_id: "org_demo_001",
    message_id: raw.message_id || `<${raw.id}@batch-test>`,
    sender,
    recipients,
    subject: (raw.subject || "").replace(/\r\n/g, " ").replace(/\t/g, " "),
    body_text: (raw.body_plain || "").slice(0, 5000),  // truncate large bodies
    body_html: "",  // skip HTML to keep payloads small
    headers: {
      "Authentication-Results": authResults,
      ...(raw.reply_to ? { "Reply-To": raw.reply_to } : {}),
    },
    attachments: (raw.attachments || []).map((a) =>
      typeof a === "string" ? { filename: a, size: 0 } : a
    ),
  };
}

// Results tracking
const results = { allow: 0, quarantine: 0, block: 0, error: 0 };
const details = [];

async function analyze(email, idx, raw) {
  const payload = transform(raw);
  try {
    const res = await fetch(`${GATEWAY}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      results.error++;
      details.push({ idx: idx + 1, id: raw.id, label: raw.label, verdict: "ERROR", error: text.slice(0, 100) });
      return;
    }
    const resp = JSON.parse(text);
    results[resp.verdict]++;
    details.push({
      idx: idx + 1,
      id: raw.id?.slice(0, 12),
      actual_label: raw.label,
      verdict: resp.verdict,
      threat_score: resp.threat_score,
      signals: resp.signals_fired?.length || 0,
      fast_ms: resp.pipeline?.fast_path_ms,
    });
  } catch (err) {
    results.error++;
    details.push({ idx: idx + 1, id: raw.id, label: raw.label, verdict: "ERROR", error: err.message });
  }
}

// Run with concurrency limit
async function run() {
  console.log(`\nSending ${emails.length} emails to ${GATEWAY}/v1/analyze ...\n`);
  const start = Date.now();

  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const batch = emails.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((raw, j) => analyze(null, i + j, raw)));
    process.stdout.write(`  Processed ${Math.min(i + CONCURRENCY, emails.length)}/${emails.length}\r`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\nCompleted in ${elapsed}s\n`);

  // Print table
  console.log("─".repeat(90));
  console.log(
    "#".padStart(4),
    "ID".padEnd(14),
    "Actual".padEnd(10),
    "Verdict".padEnd(12),
    "Score".padStart(6),
    "Signals".padStart(8),
    "Fast(ms)".padStart(10),
  );
  console.log("─".repeat(90));
  for (const d of details) {
    const match = d.actual_label === "ham" && d.verdict === "allow" ? "✓"
      : d.actual_label !== "ham" && d.verdict !== "allow" ? "✓"
      : "✗";
    console.log(
      String(d.idx).padStart(4),
      (d.id || "").padEnd(14),
      (d.actual_label || "").padEnd(10),
      (d.verdict || "").padEnd(12),
      String(d.threat_score ?? d.error ?? "").padStart(6),
      String(d.signals ?? "").padStart(8),
      String(d.fast_ms ?? "").padStart(10),
      match,
    );
  }
  console.log("─".repeat(90));

  console.log(`\nSummary:`);
  console.log(`  Allow:      ${results.allow}`);
  console.log(`  Quarantine: ${results.quarantine}`);
  console.log(`  Block:      ${results.block}`);
  console.log(`  Errors:     ${results.error}`);
  console.log(`  Total:      ${emails.length}`);
}

run().catch(console.error);
