// Gateway — Phase 1 complete.
//
// - Staged fanout: E1 (rspamd) runs first; its signals are forwarded into E2
//   (SLM) as prior_signals (PRD 6.2 dependency graph: rspamd → SLM).
// - Per-org registry lookup with thresholds, timezone, and ramp-weight.
// - Ramp: stats_db signals scale 0→1 over 30 days from org.onboarded_at.
// - Admin APIs: POST /v1/orgs, PUT /v1/orgs/:id/thresholds.
// - Management APIs: feedback, verdicts, stats (from Phase 1 first pass).

import express from "express";
import { request } from "undici";
import { Email } from "@etdp/shared/schemas";
import { safeQuery, safeOrgQuery, provisionOrg } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";
import { produce, kafkaEnabled, TOPIC_DEEP_PATH } from "@etdp/shared/kafka";
import { signalsToFeatures } from "@etdp/shared/features";
import { predictProba } from "@etdp/shared/logreg";
import { getDeployments } from "@etdp/shared/modelRegistry";
import { renderStatusPage } from "./statusPage.js";
import { renderDashboardPage } from "./dashboardPage.js";

const FAST_PRE = ["e1_rspamd"];                        // stage 1 (E1 alone)
const FAST_MAIN = ["e2_slm", "e3_stats_db", "e4_graph_db"]; // stage 2
const DEEP_PATH = ["e5_url_scanner", "e6_attachment", "e7_visual", "e9_specialized_ml"];
const DEEP_PATH_THRESHOLD = 0.85;

const ENGINE_HOSTS = Object.fromEntries(
  [...FAST_PRE, ...FAST_MAIN, ...DEEP_PATH, "e8_sandbox", "synthesizer"].map((name) => [
    name,
    process.env[`${name.toUpperCase()}_URL`] || `http://${name}:80`,
  ]),
);

async function callEngine(name, email) {
  const url = `${ENGINE_HOSTS[name]}/analyze`;
  try {
    const { statusCode, body } = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(email),
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    });
    const text = await body.text();
    if (statusCode >= 400) {
      return { engine: name, latency_ms: 0, signals: [], error: `HTTP ${statusCode}: ${text}` };
    }
    return JSON.parse(text);
  } catch (err) {
    return { engine: name, latency_ms: 0, signals: [], error: err.message };
  }
}

async function fanout(engines, email) {
  return Promise.all(engines.map((e) => callEngine(e, email)));
}

// Per-org config, cached in Redis (5min). Auto-creates a ghost org_context
// for unknown orgs (don't hard-fail in scaffold mode).
async function loadOrgContext(orgId) {
  return cached(`orgctx:${orgId}`, 300, async () => {
    const r = await safeQuery(
      `SELECT o.industry, o.timezone, o.business_hours_start, o.business_hours_end,
              o.thresholds, o.onboarded_at,
              p.bec_weight, p.phishing_weight, p.malware_weight
       FROM orgs o LEFT JOIN industry_priors p ON o.industry = p.industry
       WHERE o.org_id = ? LIMIT 1`,
      [orgId],
    );
    if (!r.ok || r.rows.length === 0) {
      return {
        known: false,
        industry: "general", timezone: "UTC",
        business_hours_start: 8, business_hours_end: 20,
        thresholds: { block: 15, quarantine: 8 },
        stats_db_weight: 1.0,
        graph_db_weight: 1.0,
        industry_weights: { bec: 1, phishing: 1, malware: 1 },
      };
    }
    const row = r.rows[0];
    const onboardedMs = new Date(row.onboarded_at).getTime();
    const daysSince = (Date.now() - onboardedMs) / 86400000;
    const statsWeight = Math.min(Math.max(daysSince / 30, 0), 1);
    const graphWeight = Math.min(Math.max(daysSince / 60, 0), 1);  // 60-day ramp per PRD §9.2
    return {
      known: true,
      industry: row.industry,
      timezone: row.timezone,
      business_hours_start: row.business_hours_start,
      business_hours_end: row.business_hours_end,
      thresholds: typeof row.thresholds === "string" ? JSON.parse(row.thresholds) : row.thresholds,
      stats_db_weight: statsWeight,
      graph_db_weight: graphWeight,
      industry_weights: {
        bec: Number(row.bec_weight || 1),
        phishing: Number(row.phishing_weight || 1),
        malware: Number(row.malware_weight || 1),
      },
    };
  });
}

export function aggregate(signals, thresholds, industryWeights) {
  // Apply industry weight: scale phishing/malware signals if the org's
  // industry prior raises them.
  let total = 0;
  for (const s of signals) {
    let w = 1;
    if (/phish|dmarc|credential/i.test(s.signal)) w = industryWeights.phishing;
    if (/malware|macro|pe_|dangerous/i.test(s.signal)) w = industryWeights.malware;
    if (/wire|transfer|bec|urgency/i.test(s.signal)) w = industryWeights.bec;
    total += (s.score || 0) * w;
  }
  const blockAt = Number(thresholds.block ?? 15);
  const qAt = Number(thresholds.quarantine ?? 8);
  if (total >= blockAt) {
    return { total, label: "phishing", verdict: "block",
      reason: `Aggregate score ${total.toFixed(1)} ≥ block threshold ${blockAt}.` };
  }
  if (total >= qAt) {
    return { total, label: "spam", verdict: "quarantine",
      reason: `Aggregate score ${total.toFixed(1)} ≥ quarantine threshold ${qAt}.` };
  }
  return { total, label: "ham", verdict: "allow",
    reason: "No significant threat signals." };
}

// Score the email against the org's incumbent/canary models, choosing
// one deterministically via a hash of message_id so the same email
// consistently hits the same model (stable A/B test).
async function scoreOrgModel(orgId, signals, messageId) {
  const deployments = await cached(`deploys:${orgId}`, 30,
    () => getDeployments(orgId));
  if (!deployments || deployments.length === 0) return null;
  const incumbent = deployments.find((d) => d.role === "incumbent");
  const canary = deployments.find((d) => d.role === "canary");

  // Which model handles this request?
  let chosen = incumbent;
  if (canary) {
    const shard = hashMod100(messageId);
    if (shard < Number(canary.traffic_pct || 0)) chosen = canary;
  }
  if (!chosen) return null;

  const features = signalsToFeatures(signals);
  const proba = predictProba(chosen.weights, chosen.intercept, features);
  return {
    model_version: chosen.model_version,
    model_role: chosen.role,
    probability: Number(proba.toFixed(4)),
    features_on: features.reduce((a, v) => a + v, 0),
  };
}

function hashMod100(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100;
}

async function persistVerdict(email, verdict) {
  await safeOrgQuery(email.org_id,
    `INSERT INTO verdicts
       (org_id, message_id, sender, recipient, verdict, label, confidence,
        threat_score, reason, signals, pipeline, fast_path_ms, deep_path_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verdict=VALUES(verdict), label=VALUES(label), confidence=VALUES(confidence),
       threat_score=VALUES(threat_score), reason=VALUES(reason),
       signals=VALUES(signals), pipeline=VALUES(pipeline),
       fast_path_ms=VALUES(fast_path_ms), deep_path_ms=VALUES(deep_path_ms)`,
    [
      email.org_id, email.message_id, email.sender,
      (email.recipients && email.recipients[0]) || "",
      verdict.verdict, verdict.label, verdict.confidence,
      verdict.threat_score, verdict.reason,
      JSON.stringify(verdict.signals_fired),
      JSON.stringify(verdict.pipeline),
      verdict.pipeline.fast_path_ms ?? null,
      verdict.pipeline.deep_path_ms ?? null,
    ],
  );
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

app.post("/v1/analyze", async (req, res) => {
  let email;
  try { email = Email.parse(req.body); }
  catch (err) { return res.status(400).json({ error: `invalid email payload: ${err.message}` }); }

  const orgCtx = await loadOrgContext(email.org_id);
  // Lazy provision: ensure per-org DB exists before engines query it.
  // Cheap after first hit (CREATE DATABASE IF NOT EXISTS + in-memory cache).
  await provisionOrg(email.org_id).catch(() => {});
  const enrichedEmail = { ...email, org_context: orgCtx };

  const t0 = process.hrtime.bigint();

  // Stage 1: rspamd alone.
  const preResponses = await fanout(FAST_PRE, enrichedEmail);
  const preSignals = preResponses.flatMap((r) => r.signals || []);

  // Stage 2: SLM sees rspamd signals via prior_signals; Stats/Graph run in parallel.
  const stage2Payload = { ...enrichedEmail, prior_signals: preSignals };
  const mainResponses = await fanout(FAST_MAIN, stage2Payload);
  const fastSignals = [...preSignals, ...mainResponses.flatMap((r) => r.signals || [])];

  const fastAgg = aggregate(fastSignals, orgCtx.thresholds, orgCtx.industry_weights);
  const fastMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const fastConfidence = Math.min(fastAgg.total / 15, 1);
  let deepSignals = [];
  let deepMs = 0;
  const enginesInvoked = [...FAST_PRE, ...FAST_MAIN];
  let asyncDeepPath = false;

  if (fastConfidence < DEEP_PATH_THRESHOLD) {
    // Try the async path first: quarantine + Kafka publish. Deep worker
    // will update the verdict row when it finishes. Falls back to sync.
    if (kafkaEnabled()) {
      const pub = await produce(TOPIC_DEEP_PATH, email.message_id, {
        email, fast_signals: fastSignals, org_context: orgCtx,
      });
      if (pub.ok) asyncDeepPath = true;
    }
    if (!asyncDeepPath) {
      const t1 = process.hrtime.bigint();
      const deepPayload = { ...enrichedEmail, prior_signals: fastSignals };
      const deepResponses = await fanout(DEEP_PATH, deepPayload);
      deepSignals = deepResponses.flatMap((r) => r.signals || []);
      deepMs = Number(process.hrtime.bigint() - t1) / 1e6;
      enginesInvoked.push(...DEEP_PATH);
    }
  }

  const allSignals = [...fastSignals, ...deepSignals];
  const finalAgg = asyncDeepPath
    ? { total: fastAgg.total, label: "spam", verdict: "quarantine",
        reason: `Awaiting deep path (fast score ${fastAgg.total.toFixed(1)}).` }
    : aggregate(allSignals, orgCtx.thresholds, orgCtx.industry_weights);

  // ── Per-org model scoring (A/B rollout) ────────────────────────────
  // The trained logistic regression runs as a second opinion over the
  // engine signal vector. Canary deployments receive traffic_pct % of
  // requests (hash-sharded on message_id for determinism).
  const modelResult = await scoreOrgModel(email.org_id, allSignals, email.message_id);

  const verdict = {
    verdict: finalAgg.verdict,
    confidence: Math.min(finalAgg.total / 15, 1),
    label: finalAgg.label,
    threat_score: Number(finalAgg.total.toFixed(2)),
    reason: finalAgg.reason,
    threats: [{ category: "aggregate", score: finalAgg.total }],
    signals_fired: allSignals,
    iocs: { urls: [], domains: [], ips: [], hashes: [] },
    actions_taken: [finalAgg.verdict],
    pipeline: {
      fast_path_ms: Number(fastMs.toFixed(2)),
      deep_path_ms: Number(deepMs.toFixed(2)),
      engines_invoked: enginesInvoked,
      stats_db_weight: orgCtx.stats_db_weight,
      async_deep_path: asyncDeepPath,
    },
    metadata: {
      org_id: email.org_id, message_id: email.message_id,
      model_version: "phase2-0.1",
      org_known: orgCtx.known,
      industry: orgCtx.industry,
      org_model: modelResult,
    },
  };

  await persistVerdict(email, verdict);
  res.json(verdict);
});

// ── Feedback + history (unchanged from Phase 1 first pass) ───────────────

app.post("/v1/feedback", async (req, res) => {
  const { org_id, message_id, action, source = "user", notes = null } = req.body || {};
  if (!org_id || !message_id || !action) {
    return res.status(400).json({ error: "org_id, message_id, action required" });
  }
  const valid = ["spam", "ham", "phishing", "not_spam", "release", "confirm_block"];
  if (!valid.includes(action)) {
    return res.status(400).json({ error: `action must be one of ${valid.join(", ")}` });
  }
  const r = await safeOrgQuery(org_id,
    `INSERT INTO feedback_labels (org_id, message_id, action, source, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [org_id, message_id, action, source, notes],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ status: "ok", id: r.rows.insertId });
});

app.get("/v1/verdicts", async (req, res) => {
  const { org_id, label, verdict, since, limit = "50" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const clauses = ["org_id = ?"];
  const params = [org_id];
  if (label) { clauses.push("label = ?"); params.push(label); }
  if (verdict) { clauses.push("verdict = ?"); params.push(verdict); }
  if (since) { clauses.push("created_at >= ?"); params.push(new Date(since)); }
  const limitN = Math.min(Number(limit) || 50, 500);
  const r = await safeOrgQuery(org_id,
    `SELECT id, org_id, message_id, sender, recipient, verdict, label, confidence,
            threat_score, reason, fast_path_ms, deep_path_ms, created_at
     FROM verdicts WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC LIMIT ${limitN}`,
    params,
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, verdicts: r.rows });
});

app.get("/v1/stats", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT label, verdict, COUNT(*) AS n FROM verdicts WHERE org_id = ?
     GROUP BY label, verdict`,
    [org_id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, breakdown: r.rows });
});

// ── Admin (PRD §10.1) ───────────────────────────────────────────────────

app.post("/v1/orgs", async (req, res) => {
  const {
    org_id, name, industry = "general",
    timezone = "UTC", business_hours_start = 8, business_hours_end = 20,
    thresholds = { block: 15, quarantine: 8 },
  } = req.body || {};
  if (!org_id || !name) return res.status(400).json({ error: "org_id, name required" });
  const r = await safeQuery(
    `INSERT INTO orgs (org_id, name, industry, timezone,
                       business_hours_start, business_hours_end, thresholds)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), industry=VALUES(industry),
       timezone=VALUES(timezone), business_hours_start=VALUES(business_hours_start),
       business_hours_end=VALUES(business_hours_end), thresholds=VALUES(thresholds)`,
    [org_id, name, industry, timezone, business_hours_start, business_hours_end,
     JSON.stringify(thresholds)],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  const prov = await provisionOrg(org_id);
  if (!prov.ok) return res.status(500).json({ error: prov.error });
  res.json({ status: "ok", org_id, db_name: prov.db_name, provisioned: prov.provisioned });
});

app.put("/v1/orgs/:id/thresholds", async (req, res) => {
  const { id } = req.params;
  const thresholds = req.body || {};
  const r = await safeQuery(
    `UPDATE orgs SET thresholds = ? WHERE org_id = ?`,
    [JSON.stringify(thresholds), id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  if (r.rows.affectedRows === 0) return res.status(404).json({ error: "org not found" });
  res.json({ status: "ok", org_id: id, thresholds });
});

app.get("/v1/orgs/:id", async (req, res) => {
  const r = await safeQuery(`SELECT * FROM orgs WHERE org_id = ?`, [req.params.id]);
  if (!r.ok) return res.status(500).json({ error: r.error });
  if (r.rows.length === 0) return res.status(404).json({ error: "org not found" });
  res.json(r.rows[0]);
});

// ── Model registry (PRD §10.1 admin APIs) ──────────────────────────────

app.get("/v1/orgs/:id/models", async (req, res) => {
  const r = await safeQuery(
    `SELECT version, model_kind, val_accuracy, val_precision, val_recall,
            val_fp_rate, trained_at, trained_on, status, parent_version
     FROM org_models WHERE org_id=? ORDER BY trained_at DESC LIMIT 50`,
    [req.params.id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, models: r.rows });
});

app.get("/v1/orgs/:id/deployments", async (req, res) => {
  const deployments = await getDeployments(req.params.id);
  res.json(deployments.map((d) => ({
    role: d.role, model_version: d.model_version, traffic_pct: d.traffic_pct,
    val_accuracy: d.val_accuracy ?? null,
  })));
});

app.get("/v1/orgs/:id/training_jobs", async (req, res) => {
  const r = await safeQuery(
    `SELECT id, started_at, finished_at, status, labels_used,
            resulting_version, notes
     FROM training_jobs WHERE org_id=? ORDER BY started_at DESC LIMIT 50`,
    [req.params.id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, jobs: r.rows });
});

// ── Org listing (for dashboard dropdown) ──────────────────────────────

app.get("/v1/orgs", async (_req, res) => {
  const r = await safeQuery("SELECT org_id, name, industry FROM orgs ORDER BY name");
  res.json(r.ok ? r.rows : []);
});

// ── Full verdict detail (signals + pipeline + feedback) ───────────────

app.get("/v1/verdicts/:org_id/:message_id", async (req, res) => {
  const { org_id, message_id } = req.params;
  const vr = await safeOrgQuery(org_id,
    `SELECT id, org_id, message_id, sender, recipient, verdict, label, confidence,
            threat_score, reason, signals, pipeline, fast_path_ms, deep_path_ms, created_at
     FROM verdicts WHERE org_id = ? AND message_id = ? LIMIT 1`,
    [org_id, message_id],
  );
  if (!vr.ok) return res.status(500).json({ error: vr.error });
  if (vr.rows.length === 0) return res.status(404).json({ error: "verdict not found" });

  const row = vr.rows[0];
  row.signals = typeof row.signals === "string" ? JSON.parse(row.signals) : row.signals;
  row.pipeline = typeof row.pipeline === "string" ? JSON.parse(row.pipeline) : row.pipeline;

  const fr = await safeOrgQuery(org_id,
    `SELECT action, source, notes, created_at FROM feedback_labels
     WHERE org_id = ? AND message_id = ? ORDER BY created_at DESC`,
    [org_id, message_id],
  );

  res.json({ verdict: row, feedback: fr.ok ? fr.rows : [] });
});

// ── Dashboard Data APIs ──────────────────────────────────────────────

app.get("/v1/dashboard/timeline", async (req, res) => {
  const { org_id, days = "7" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const daysN = Math.min(Number(days) || 7, 90);
  const r = await safeOrgQuery(org_id,
    `SELECT DATE(created_at) AS day, COUNT(*) AS value
     FROM verdicts WHERE org_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(created_at) ORDER BY day ASC`,
    [org_id, daysN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, days: daysN, points: r.rows });
});

app.get("/v1/dashboard/top-senders", async (req, res) => {
  const { org_id, limit = "20" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const limitN = Math.min(Number(limit) || 20, 100);
  const r = await safeOrgQuery(org_id,
    `SELECT sender,
            SUBSTRING_INDEX(sender, '@', -1) AS sender_domain,
            COUNT(*) AS count,
            AVG(threat_score) AS avg_score
     FROM verdicts WHERE org_id = ? AND verdict IN ('block','quarantine')
     GROUP BY sender ORDER BY avg_score DESC LIMIT ?`,
    [org_id, limitN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, senders: r.rows });
});

app.get("/v1/dashboard/users", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT recipient,
            COUNT(*) AS total,
            SUM(verdict = 'block') AS blocked,
            SUM(verdict = 'quarantine') AS quarantined,
            SUM(verdict = 'allow') AS allowed,
            AVG(threat_score) AS avg_score
     FROM verdicts WHERE org_id = ?
     GROUP BY recipient ORDER BY blocked DESC, quarantined DESC LIMIT 50`,
    [org_id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, users: r.rows });
});

app.get("/v1/dashboard/vips", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT gdn.address, gdn.display_name,
            COALESCE(gt.trust_score, 0.5) AS trust_score,
            COALESCE(gn.sent_count, 0) AS sent_count,
            COALESCE(gn.recv_count, 0) AS recv_count,
            (SELECT COUNT(*) FROM verdicts v WHERE v.org_id = ? AND v.recipient = gdn.address AND v.verdict IN ('block','quarantine')) AS threat_count
     FROM graph_display_names gdn
     LEFT JOIN graph_trust gt ON gt.org_id = gdn.org_id AND gt.address = gdn.address
     LEFT JOIN graph_nodes gn ON gn.org_id = gdn.org_id AND gn.address = gdn.address
     WHERE gdn.org_id = ?
     ORDER BY threat_count DESC, trust_score ASC LIMIT 20`,
    [org_id, org_id],
  );
  // If graph tables don't exist yet, return empty
  if (!r.ok) return res.json({ org_id, vips: [] });
  res.json({ org_id, vips: r.rows });
});

app.get("/v1/dashboard/domains", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT domain, first_seen, total_emails_from, is_freemail, avg_threat_score
     FROM domain_first_seen WHERE org_id = ?
     ORDER BY avg_threat_score DESC, total_emails_from DESC LIMIT 100`,
    [org_id],
  );
  if (!r.ok) return res.json({ org_id, domains: [] });
  res.json({ org_id, domains: r.rows });
});

app.get("/v1/dashboard/urls", async (req, res) => {
  const { limit = "100" } = req.query;
  const limitN = Math.min(Number(limit) || 100, 500);
  const r = await safeQuery(
    `SELECT url, final_url, redirect_hops, final_status, risk_score, scanned_at
     FROM url_scan_cache ORDER BY scanned_at DESC LIMIT ?`,
    [limitN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ urls: r.rows });
});

// ── SOC Analyst Dashboard ─────────────────────────────────────────────

app.get("/admin/dashboard", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderDashboardPage());
});

// ── Service Status Dashboard (admin) ────────────────────────────────────

const ALL_SERVICES = Object.fromEntries([
  ...Object.entries(ENGINE_HOSTS),
  ["deep_path_worker", process.env.DEEP_PATH_WORKER_URL || "http://deep_path_worker:80"],
]);

const VALID_SERVICE_NAMES = new Set(Object.keys(ALL_SERVICES));

app.get("/admin/status", async (_req, res) => {
  const results = await Promise.all(
    Object.entries(ALL_SERVICES).map(async ([name, baseUrl]) => {
      const start = Date.now();
      try {
        const { statusCode, body } = await request(`${baseUrl}/health`, {
          method: "GET",
          headersTimeout: 3000,
          bodyTimeout: 3000,
        });
        const text = await body.text();
        const elapsed = Date.now() - start;
        if (statusCode >= 400) {
          return { name, status: "down", latency_ms: elapsed, error: `HTTP ${statusCode}` };
        }
        return { name, status: "ok", latency_ms: elapsed };
      } catch (err) {
        return { name, status: "down", latency_ms: Date.now() - start, error: err.message };
      }
    }),
  );
  res.json(results);
});

app.post("/admin/restart/:service", async (req, res) => {
  const { service } = req.params;
  if (!VALID_SERVICE_NAMES.has(service)) {
    return res.status(400).json({ error: `unknown service: ${service}` });
  }
  const baseUrl = ALL_SERVICES[service];
  try {
    const { statusCode, body } = await request(`${baseUrl}/shutdown`, {
      method: "POST",
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    await body.text();
    if (statusCode >= 400) {
      return res.status(502).json({ error: `shutdown returned HTTP ${statusCode}` });
    }
    res.json({ status: "restarting", service });
  } catch (err) {
    res.status(502).json({ error: `failed to reach ${service}: ${err.message}` });
  }
});

app.get("/admin/ui", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderStatusPage());
});

if (process.env.ETDP_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT || 8000);
  app.listen(port, () => console.log(`[gateway] listening on :${port}`));
}

export { app };
