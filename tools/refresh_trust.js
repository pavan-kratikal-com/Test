#!/usr/bin/env node
// Nightly trust-score refresh (PRD §7.4).
//
// For every node in the org's graph compute:
//   trust_score           — [0,1] score combining frequency + reciprocity + age + decay
//   reply_reciprocity     — reverse_edges / forward_edges, clamped
//   relationship_age_days — days since first_seen
//
// Usage:
//   node tools/refresh_trust.js --org <org_id>
//   node tools/refresh_trust.js --all           (iterate every active org)
import { safeQuery, safeOrgQuery } from "@etdp/shared/mysql";

const argv = process.argv.slice(2);
function arg(n, f) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : f; }
const target = arg("--org");
const all = argv.includes("--all");

async function listOrgs() {
  const r = await safeQuery(`SELECT org_id FROM orgs WHERE status='active'`);
  return r.ok ? r.rows.map((x) => x.org_id) : [];
}

// Decay dormancy: an edge unused for N days exponentially loses trust weight.
function dormancyMultiplier(daysSinceLastSeen, halfLifeDays = 60) {
  return Math.pow(0.5, daysSinceLastSeen / halfLifeDays);
}

async function refreshOrg(orgId) {
  const nodes = await safeOrgQuery(orgId,
    `SELECT address, first_seen, last_seen, total_sent, total_received FROM graph_nodes`);
  if (!nodes.ok) { console.log(`[trust] ${orgId}: skipped (${nodes.error})`); return; }

  for (const n of nodes.rows) {
    const ageDays = Math.max(1, (Date.now() - new Date(n.first_seen).getTime()) / 86400000);
    const dormantDays = Math.max(0, (Date.now() - new Date(n.last_seen).getTime()) / 86400000);

    // Reciprocity: edges where this node is dst / edges where it's src.
    const forward = await safeOrgQuery(orgId,
      `SELECT COALESCE(SUM(count),0) AS c FROM graph_edges WHERE src=?`, [n.address]);
    const reverse = await safeOrgQuery(orgId,
      `SELECT COALESCE(SUM(count),0) AS c FROM graph_edges WHERE dst=?`, [n.address]);
    const f = Number(forward.rows?.[0]?.c || 0);
    const r = Number(reverse.rows?.[0]?.c || 0);
    const reciprocity = f === 0 ? 0 : Math.min(1, r / Math.max(1, f));

    // Frequency component: log-scaled so 1 msg=0, 10=~1, 100=~2.
    const freq = Math.log10(1 + Number(n.total_sent || 0) + Number(n.total_received || 0));
    // Age component: asymptotes at 1 after ~1 year.
    const ageComp = Math.min(1, ageDays / 365);
    const decay = dormancyMultiplier(dormantDays);

    // Combine: reciprocity + freq + age, weighted, then multiplied by decay.
    const raw = (0.4 * reciprocity + 0.3 * Math.min(1, freq / 2) + 0.3 * ageComp) * decay;
    const trustScore = Math.max(0, Math.min(1, raw));

    await safeOrgQuery(orgId,
      `INSERT INTO graph_trust
         (org_id, address, trust_score, reply_reciprocity, relationship_age_days, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         trust_score=VALUES(trust_score),
         reply_reciprocity=VALUES(reply_reciprocity),
         relationship_age_days=VALUES(relationship_age_days),
         updated_at=NOW(3)`,
      [orgId, n.address, trustScore, reciprocity, Math.round(ageDays)],
    );
  }
  console.log(`[trust] ${orgId}: refreshed ${nodes.rows.length} nodes`);
}

if (all) {
  const orgs = await listOrgs();
  for (const o of orgs) await refreshOrg(o);
} else if (target) {
  await refreshOrg(target);
} else {
  console.error("usage: refresh_trust.js --org <id> | --all");
  process.exit(2);
}
console.log("[trust] done");
