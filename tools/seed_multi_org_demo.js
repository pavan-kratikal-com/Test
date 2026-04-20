#!/usr/bin/env node
// Provision multiple orgs end-to-end to satisfy the PRD §14.2 exit
// criterion: "at least 3 orgs with per-org models deployed".
//
// For each org in the DEMO_ORGS list:
//   1. POST /v1/orgs      — register + provision per-org DB
//   2. POST /v1/analyze   — stream a balanced mix of ham / phish emails
//   3. POST /v1/feedback  — label each one with its ground truth
//   4. spawn tools/train.js — fit a logistic model, deploy as incumbent
//
// Then prints the deployments across all demo orgs.
import { spawn } from "node:child_process";
import { request } from "undici";

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8000";

const DEMO_ORGS = [
  { org_id: "org_acme_corp",     name: "ACME Corp",    industry: "tech" },
  { org_id: "org_demo_bank",     name: "Demo Bank",    industry: "banking" },
  { org_id: "org_demo_hospital", name: "City Hospital", industry: "healthcare" },
];

function json(method, path, body) {
  return request(`${GATEWAY}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const text = await r.body.text();
    if (r.statusCode >= 400) throw new Error(`${method} ${path}: ${r.statusCode} ${text}`);
    return JSON.parse(text);
  });
}

function phishEmail(org, n) {
  return {
    org_id: org, message_id: `<p-${org}-${n}@demo>`,
    sender: "evil@login-microsft.top",
    recipients: ["finance@example.com"],
    subject: "URGENT wire transfer",
    body_text: `Process ASAP https://login-microsft.top/auth  (#${n})`,
    headers: { "Authentication-Results": "dmarc=fail" },
    attachments: [],
  };
}

function hamEmail(org, n) {
  return {
    org_id: org, message_id: `<h-${org}-${n}@demo>`,
    sender: "alice@example.com",
    recipients: ["bob@example.com"],
    subject: "lunch?",
    body_text: `See you at noon. (#${n})`,
    headers: {
      From: "alice@example.com", To: "bob@example.com",
      Subject: "lunch?", Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": `<h-${org}-${n}@example.com>`,
    },
    attachments: [],
  };
}

async function trainCmd(orgId) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["tools/train.js", "--org", orgId,
      "--min-labels", "10", "--deploy-incumbent"], {
      env: process.env, stdio: "inherit",
    });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`train exited ${code}`)));
  });
}

for (const org of DEMO_ORGS) {
  console.log(`\n=== ${org.org_id} (${org.industry}) ===`);

  await json("POST", "/v1/orgs", {
    ...org,
    thresholds: { block: 10, quarantine: 5 },
  });

  // Stream 8 ham + 8 phish messages, labeling each.
  for (let i = 0; i < 8; i++) {
    const h = hamEmail(org.org_id, i);
    await json("POST", "/v1/analyze", h);
    await json("POST", "/v1/feedback", {
      org_id: org.org_id, message_id: h.message_id, action: "ham",
    });
    const p = phishEmail(org.org_id, i);
    await json("POST", "/v1/analyze", p);
    await json("POST", "/v1/feedback", {
      org_id: org.org_id, message_id: p.message_id, action: "phishing",
    });
  }

  console.log(`[demo] ${org.org_id}: 16 labeled messages → training…`);
  await trainCmd(org.org_id);
}

console.log("\n=== Summary ===");
for (const org of DEMO_ORGS) {
  const deployments = await json("GET", `/v1/orgs/${org.org_id}/deployments`);
  console.log(`${org.org_id}: ${deployments.length} deployment(s)`);
  for (const d of deployments) {
    console.log(`  - ${d.role} ${d.model_version} @ ${d.traffic_pct}% (val_acc=${d.val_accuracy ?? "n/a"})`);
  }
}
