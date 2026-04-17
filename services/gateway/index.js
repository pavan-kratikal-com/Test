// Gateway: orchestrates fast path (E1-E4) and deep path (E5-E9 + synthesizer).
// Stub behavior: fans out to engine stubs over HTTP, aggregates signals via
// weighted sum, returns a FinalVerdict. No real ML, no quarantine, no async
// deep-path queue yet.
import express from "express";
import { request } from "undici";
import { Email } from "@etdp/shared/schemas";

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

  res.json({
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
      model_version: "scaffold-0.1",
    },
  });
});

const port = Number(process.env.PORT || 8000);
app.listen(port, () => console.log(`[gateway] listening on :${port}`));
