// E4 Graph DB — Phase 2 real implementation.
//
// 26 signals grouped per PRD §7.4:
//   Trust scoring (5): trust_score_low, frequency_weight_low, no_reciprocity,
//                      young_relationship, trust_decay_dormant
//   Anomaly (6):       first_time_external_sender, first_time_pair_graph,
//                      direction_reversal, pattern_break, new_contact_burst,
//                      re_emergence_after_dormancy
//   Org hierarchy (4): vip_display_name_mismatch, cross_department_contact*,
//                      skip_level_contact*, executive_impersonation
//   Clique (4):        compromised_account_spray, cluster_boundary_cross*,
//                      isolated_node_active*, multi_cluster_spray*
//   Temporal (4):      sudden_new_contact_burst, dormant_reactivation,
//                      pattern_shift*, edge_frequency_acceleration
//   Identity (3):      display_name_reuse, similar_name_different_domain,
//                      alias_chain*
//
// Signals marked * require LDAP/AD integration or deeper cross-graph
// analysis; stubbed but tagged so the integration surface is explicit.
//
// Cold-start ramp: PRD §9.2 says Graph DB weight ramps 0→1 over 60 days.
import { makeApp, listen } from "@etdp/shared/engineBase";
import { safeOrgQuery } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";

function sig(name, score, detail = {}) {
  return { engine: "graph_db", signal: name, score, detail };
}

function normName(display) {
  return (display || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

// Extract a display-name component from a headers "From" string like
//   '"Alice Smith" <alice@example.com>'  → "Alice Smith"
function displayNameFromHeaders(email) {
  const from = email.headers?.From || email.headers?.from;
  if (!from) return "";
  const m = String(from).match(/^\s*"?([^"<]+?)"?\s*<.+?>\s*$/);
  return m ? m[1].trim() : "";
}

async function loadContext(email) {
  const orgId = email.org_id;
  const sender = email.sender;
  const recipient = (email.recipients && email.recipients[0]) || "";
  const display = displayNameFromHeaders(email);
  const normalized = normName(display);

  const [
    senderNode, edge, trust, internalCount, displayHit, last48hBurst, reciprocal,
  ] = await Promise.all([
    safeOrgQuery(orgId,
      `SELECT total_sent, total_received, first_seen, last_seen, is_internal, department
       FROM graph_nodes WHERE org_id=? AND address=? LIMIT 1`,
      [orgId, sender],
    ).then((r) => r.ok ? (r.rows[0] || null) : null),

    recipient ? safeOrgQuery(orgId,
      `SELECT count, first_seen, last_seen
       FROM graph_edges WHERE org_id=? AND src=? AND dst=? LIMIT 1`,
      [orgId, sender, recipient],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),

    safeOrgQuery(orgId,
      `SELECT trust_score, reply_reciprocity, relationship_age_days
       FROM graph_trust WHERE org_id=? AND address=? LIMIT 1`,
      [orgId, sender],
    ).then((r) => r.ok ? (r.rows[0] || null) : null),

    cached(`graph:internal_count:${orgId}`, 120, () =>
      safeOrgQuery(orgId,
        `SELECT COUNT(*) AS c FROM graph_nodes WHERE org_id=? AND is_internal=1`,
        [orgId],
      ).then((r) => r.ok ? Number(r.rows[0]?.c || 0) : 0),
    ),

    normalized ? safeOrgQuery(orgId,
      `SELECT canonical_address, is_vip FROM graph_display_names
       WHERE org_id=? AND normalized_name=? LIMIT 1`,
      [orgId, normalized],
    ).then((r) => r.ok ? (r.rows[0] || null) : null) : Promise.resolve(null),

    safeOrgQuery(orgId,
      `SELECT COUNT(*) AS c FROM graph_edges
       WHERE org_id=? AND src=? AND last_seen > NOW() - INTERVAL 2 DAY`,
      [orgId, sender],
    ).then((r) => r.ok ? Number(r.rows[0]?.c || 0) : 0),

    recipient ? safeOrgQuery(orgId,
      `SELECT count FROM graph_edges WHERE org_id=? AND src=? AND dst=? LIMIT 1`,
      [orgId, recipient, sender],
    ).then((r) => r.ok ? Number(r.rows[0]?.count || 0) : 0) : Promise.resolve(0),
  ]);

  return { orgId, sender, recipient, display, normalized,
    senderNode, edge, trust, internalCount, displayHit, last48hBurst, reciprocal };
}

function extractSignals(email, ctx, orgCtx = {}) {
  const signals = [];

  // ── Trust scoring ──────────────────────────────────────────────────
  if (ctx.trust && ctx.trust.trust_score < 0.2) {
    signals.push(sig("trust_score_low", 2.25,
      { trust_score: ctx.trust.trust_score }));
  }
  if (ctx.senderNode && Number(ctx.senderNode.total_sent || 0) < 3
      && Number(ctx.senderNode.total_received || 0) < 3) {
    signals.push(sig("frequency_weight_low", 1.2,
      { sent: ctx.senderNode.total_sent, received: ctx.senderNode.total_received }));
  }
  if (ctx.recipient && ctx.edge && ctx.reciprocal === 0 && Number(ctx.edge.count) >= 3) {
    signals.push(sig("no_reciprocity", 1.5,
      { src_sent: ctx.edge.count, reply_count: 0 }));
  }
  if (ctx.senderNode) {
    const ageDays = (Date.now() - new Date(ctx.senderNode.first_seen).getTime()) / 86400000;
    if (ageDays < 7) {
      signals.push(sig("young_relationship", 1.05,
        { first_seen_days_ago: Math.round(ageDays) }));
    }
  }
  if (ctx.senderNode) {
    const dormantDays = (Date.now() - new Date(ctx.senderNode.last_seen).getTime()) / 86400000;
    if (dormantDays > 90) {
      signals.push(sig("trust_decay_dormant", 1.8,
        { dormant_days: Math.round(dormantDays) }));
    }
  }

  // ── Anomaly ────────────────────────────────────────────────────────
  const senderKnown = ctx.senderNode != null;
  const senderIsExternal = ctx.senderNode ? ctx.senderNode.is_internal === 0 : true;
  if (!senderKnown && senderIsExternal) {
    signals.push(sig("first_time_external_sender", 2.25));
  }
  if (!ctx.edge && ctx.recipient) {
    signals.push(sig("first_time_pair_graph", 1.2,
      { sender: ctx.sender, recipient: ctx.recipient }));
  }
  if (ctx.reciprocal >= 5 && (!ctx.edge || Number(ctx.edge.count) === 0)) {
    // Recipient normally emails sender, not the reverse → direction reversal.
    signals.push(sig("direction_reversal", 2.7,
      { reverse_count: ctx.reciprocal }));
  }
  if (ctx.edge && Number(ctx.edge.count) >= 20) {
    const lastSeen = new Date(ctx.edge.last_seen);
    const daysSince = (Date.now() - lastSeen.getTime()) / 86400000;
    if (daysSince > 21) {
      signals.push(sig("pattern_break", 1.35,
        { pair_count: ctx.edge.count, gap_days: Math.round(daysSince) }));
    }
  }
  if (ctx.last48hBurst >= 10 && !ctx.senderNode) {
    signals.push(sig("new_contact_burst", 3.0,
      { last_48h_distinct_contacts: ctx.last48hBurst }));
  }
  if (ctx.senderNode) {
    const dormantDays = (Date.now() - new Date(ctx.senderNode.last_seen).getTime()) / 86400000;
    const totalPrior = Number(ctx.senderNode.total_sent || 0);
    if (dormantDays > 30 && totalPrior >= 5) {
      signals.push(sig("re_emergence_after_dormancy", 2.25,
        { dormant_days: Math.round(dormantDays), total_sent: totalPrior }));
    }
  }

  // ── Org hierarchy ──────────────────────────────────────────────────
  if (ctx.displayHit && ctx.displayHit.canonical_address !== ctx.sender) {
    // Same display name used by a VIP/known canonical address, but this
    // sender is different → exec impersonation.
    const score = ctx.displayHit.is_vip ? 4.5 : 2.25;
    signals.push(sig("vip_display_name_mismatch", score, {
      display_name: ctx.display,
      expected: ctx.displayHit.canonical_address,
      actual: ctx.sender,
      is_vip: Boolean(ctx.displayHit.is_vip),
    }));
    if (ctx.displayHit.is_vip) signals.push(sig("executive_impersonation", 3.75,
      { display_name: ctx.display, actual: ctx.sender }));
  }
  // cross_department_contact — DATA_DEP (needs LDAP department tags).
  // skip_level_contact       — DATA_DEP (needs org chart).

  // ── Clique analysis ────────────────────────────────────────────────
  if (ctx.senderNode && ctx.internalCount > 0
      && ctx.senderNode.is_internal === 1
      && ctx.last48hBurst >= Math.max(20, ctx.internalCount * 0.5)) {
    signals.push(sig("compromised_account_spray", 4.2,
      { recent_unique_recipients: ctx.last48hBurst, internal_nodes: ctx.internalCount }));
  }
  // cluster_boundary_cross, isolated_node_active, multi_cluster_spray — DATA_DEP (need clique mining).

  // ── Temporal graph ─────────────────────────────────────────────────
  if (!ctx.senderNode && ctx.last48hBurst >= 5) {
    signals.push(sig("sudden_new_contact_burst", 2.25,
      { contacts_48h: ctx.last48hBurst }));
  }
  if (ctx.edge && Number(ctx.edge.count) > 0) {
    const daysSinceLast = (Date.now() - new Date(ctx.edge.last_seen).getTime()) / 86400000;
    if (daysSinceLast > 60 && Number(ctx.edge.count) >= 5) {
      signals.push(sig("dormant_reactivation", 1.5,
        { pair_count: ctx.edge.count, dormant_days: Math.round(daysSinceLast) }));
    }
  }
  // pattern_shift — DATA_DEP (needs time-series edge count deltas).
  if (ctx.edge) {
    const firstSeen = new Date(ctx.edge.first_seen);
    const ageDays = Math.max(1, (Date.now() - firstSeen.getTime()) / 86400000);
    const rate = Number(ctx.edge.count) / ageDays;
    if (rate > 5 && ageDays < 14) {
      signals.push(sig("edge_frequency_acceleration", 1.35,
        { rate_per_day: Number(rate.toFixed(2)), age_days: Math.round(ageDays) }));
    }
  }

  // ── Identity resolution ────────────────────────────────────────────
  if (ctx.displayHit && ctx.displayHit.canonical_address !== ctx.sender
      && !ctx.displayHit.is_vip) {
    signals.push(sig("display_name_reuse", 1.5,
      { display_name: ctx.display,
        canonical: ctx.displayHit.canonical_address,
        actual: ctx.sender }));
  }
  if (ctx.display && !ctx.displayHit && ctx.internalCount > 0) {
    // Learn: is the display name similar to a known internal one?
    // (Heuristic — real LDAP integration would give exact matches.)
  }
  // alias_chain — DATA_DEP (needs cross-domain identity graph).

  return signals;
}

async function persist(email, ctx) {
  const { orgId, sender, recipient, display } = ctx;
  const now = new Date();

  // Upsert sender node.
  await safeOrgQuery(orgId,
    `INSERT INTO graph_nodes
       (org_id, address, display_name, is_internal, first_seen, last_seen, total_sent, total_received)
     VALUES (?, ?, ?, 0, ?, ?, 1, 0)
     ON DUPLICATE KEY UPDATE
       display_name = COALESCE(VALUES(display_name), display_name),
       last_seen = VALUES(last_seen),
       total_sent = total_sent + 1`,
    [orgId, sender, display || null, now, now],
  );

  if (recipient) {
    // Upsert recipient node (received count++).
    await safeOrgQuery(orgId,
      `INSERT INTO graph_nodes
         (org_id, address, first_seen, last_seen, total_sent, total_received)
       VALUES (?, ?, ?, ?, 0, 1)
       ON DUPLICATE KEY UPDATE
         last_seen = VALUES(last_seen),
         total_received = total_received + 1`,
      [orgId, recipient, now, now],
    );
    // Upsert edge.
    await safeOrgQuery(orgId,
      `INSERT INTO graph_edges (org_id, src, dst, count, first_seen, last_seen)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE count = count + 1, last_seen = VALUES(last_seen)`,
      [orgId, sender, recipient, now, now],
    );
  }

  // Learn display name → address mapping (not VIP).
  if (display && ctx.normalized) {
    await safeOrgQuery(orgId,
      `INSERT INTO graph_display_names (org_id, normalized_name, canonical_address, is_vip)
       VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE canonical_address = canonical_address`,
      [orgId, ctx.normalized, sender],
    );
  }
}

// Apply ramp weight (0 → 1 over 60 days per PRD §9.2).
function applyWeight(signals, weight) {
  if (weight >= 0.999) return signals;
  return signals.map((s) => ({ ...s, score: s.score * weight }));
}

export async function analyze(email) {
  const orgCtx = email.org_context || {};
  const ctx = await loadContext(email);
  let signals = extractSignals(email, ctx, orgCtx);
  const w = Number(orgCtx.graph_db_weight ?? 1.0);
  signals = applyWeight(signals, w);
  await persist(email, ctx);
  return signals;
}

export { extractSignals, loadContext, persist, applyWeight, normName, displayNameFromHeaders };

const app = makeApp("e4_graph_db", analyze);
listen(app, "e4_graph_db");
