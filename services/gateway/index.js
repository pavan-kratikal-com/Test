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
import { safeQuery } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";

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
        thresholds: { block: 10, quarantine: 5 },
        stats_db_weight: 1.0,
        industry_weights: { bec: 1, phishing: 1, malware: 1 },
      };
    }
    const row = r.rows[0];
    const onboardedMs = new Date(row.onboarded_at).getTime();
    const daysSince = (Date.now() - onboardedMs) / 86400000;
    const statsWeight = Math.min(Math.max(daysSince / 30, 0), 1);
    return {
      known: true,
      industry: row.industry,
      timezone: row.timezone,
      business_hours_start: row.business_hours_start,
      business_hours_end: row.business_hours_end,
      thresholds: typeof row.thresholds === "string" ? JSON.parse(row.thresholds) : row.thresholds,
      stats_db_weight: statsWeight,
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
  const blockAt = Number(thresholds.block ?? 10);
  const qAt = Number(thresholds.quarantine ?? 5);
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

async function persistVerdict(email, verdict) {
  await safeQuery(
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

  if (fastConfidence < DEEP_PATH_THRESHOLD) {
    const t1 = process.hrtime.bigint();
    const deepPayload = { ...enrichedEmail, prior_signals: fastSignals };
    const deepResponses = await fanout(DEEP_PATH, deepPayload);
    deepSignals = deepResponses.flatMap((r) => r.signals || []);
    deepMs = Number(process.hrtime.bigint() - t1) / 1e6;
    enginesInvoked.push(...DEEP_PATH);
  }

  const allSignals = [...fastSignals, ...deepSignals];
  const finalAgg = aggregate(allSignals, orgCtx.thresholds, orgCtx.industry_weights);

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
    },
    metadata: {
      org_id: email.org_id, message_id: email.message_id,
      model_version: "phase1-complete-0.1",
      org_known: orgCtx.known,
      industry: orgCtx.industry,
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
  const r = await safeQuery(
    `INSERT INTO feedback_labels (org_id, message_id, action, source, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [org_id, message_id, action, source, notes],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ status: "ok", id: r.rows.insertId });
});

app.get("/v1/verdicts", async (req, res) => {
  const { org_id, label, since, limit = "50" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const clauses = ["org_id = ?"];
  const params = [org_id];
  if (label) { clauses.push("label = ?"); params.push(label); }
  if (since) { clauses.push("created_at >= ?"); params.push(new Date(since)); }
  const limitN = Math.min(Number(limit) || 50, 500);
  const r = await safeQuery(
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
  const r = await safeQuery(
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
    thresholds = { block: 10, quarantine: 5 },
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
  res.json({ status: "ok", org_id });
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

if (process.env.ETDP_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT || 8000);
  app.listen(port, () => console.log(`[gateway] listening on :${port}`));
}

export { app };
