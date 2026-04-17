// Gateway: orchestrates fast path (E1-E4) and deep path (E5-E9 + synthesizer).
// Phase 1: persists verdicts in MySQL and exposes feedback + history APIs.
import express from "express";
import { request } from "undici";
import { Email } from "@etdp/shared/schemas";
import { safeQuery } from "@etdp/shared/mysql";

const FAST_PATH = ["e1_rspamd", "e2_slm", "e3_stats_db", "e4_graph_db"];
const DEEP_PATH = ["e5_url_scanner", "e6_attachment", "e7_visual", "e9_specialized_ml"];
const DEEP_PATH_THRESHOLD = 0.85;

const ENGINE_HOSTS = Object.fromEntries(
  [...FAST_PATH, ...DEEP_PATH, "e8_sandbox", "synthesizer"].map((name) => [
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

function aggregate(signals) {
  const total = signals.reduce((acc, s) => acc + (s.score || 0), 0);
  if (total >= 10) {
    return { total, label: "phishing", verdict: "block", reason: "Multiple high-severity signals fired." };
  }
  if (total >= 5) {
    return { total, label: "spam", verdict: "quarantine", reason: "Moderate signals; held for review." };
  }
  return { total, label: "ham", verdict: "allow", reason: "No significant threat signals." };
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
      email.org_id,
      email.message_id,
      email.sender,
      (email.recipients && email.recipients[0]) || "",
      verdict.verdict,
      verdict.label,
      verdict.confidence,
      verdict.threat_score,
      verdict.reason,
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
  try {
    email = Email.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: `invalid email payload: ${err.message}` });
  }

  const t0 = process.hrtime.bigint();
  const fastResponses = await fanout(FAST_PATH, email);
  const fastSignals = fastResponses.flatMap((r) => r.signals || []);
  const fastAgg = aggregate(fastSignals);
  const fastMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const fastConfidence = Math.min(fastAgg.total / 15, 1);
  let deepSignals = [];
  let deepMs = 0;
  const enginesInvoked = [...FAST_PATH];

  if (fastConfidence < DEEP_PATH_THRESHOLD) {
    const t1 = process.hrtime.bigint();
    const deepResponses = await fanout(DEEP_PATH, email);
    deepSignals = deepResponses.flatMap((r) => r.signals || []);
    deepMs = Number(process.hrtime.bigint() - t1) / 1e6;
    enginesInvoked.push(...DEEP_PATH);
  }

  const allSignals = [...fastSignals, ...deepSignals];
  const finalAgg = aggregate(allSignals);

  const verdict = {
    verdict: finalAgg.verdict,
    confidence: Math.min(finalAgg.total / 15, 1),
    label: finalAgg.label,
    threat_score: finalAgg.total,
    reason: finalAgg.reason,
    threats: [{ category: "aggregate", score: finalAgg.total }],
    signals_fired: allSignals,
    iocs: { urls: [], domains: [], ips: [], hashes: [] },
    actions_taken: [finalAgg.verdict],
    pipeline: {
      fast_path_ms: Number(fastMs.toFixed(2)),
      deep_path_ms: Number(deepMs.toFixed(2)),
      engines_invoked: enginesInvoked,
    },
    metadata: {
      org_id: email.org_id,
      message_id: email.message_id,
      model_version: "scaffold-0.2",
    },
  };

  await persistVerdict(email, verdict);
  res.json(verdict);
});

// PRD §10.1 management APIs.

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
     FROM verdicts
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ${limitN}`,
    params,
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, verdicts: r.rows });
});

app.get("/v1/stats", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeQuery(
    `SELECT label, verdict, COUNT(*) AS n
     FROM verdicts WHERE org_id = ?
     GROUP BY label, verdict`,
    [org_id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, breakdown: r.rows });
});

const port = Number(process.env.PORT || 8000);
app.listen(port, () => console.log(`[gateway] listening on :${port}`));
