// Synthesizer stub. Real impl: Gemma 3 4B / Phi-4 Mini (Q4) consuming the
// full signal vector, producing a natural-language verdict (Phase 3).
import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "synthesizer" }));

app.post("/synthesize", (req, res) => {
  const signals = (req.body && req.body.signals) || [];
  const total = signals.reduce((acc, s) => acc + (s.score || 0), 0);

  let verdict, label, reason;
  if (total >= 10) {
    verdict = "block";
    label = "phishing";
    reason = "High aggregate threat score from multiple engines.";
  } else if (total >= 5) {
    verdict = "quarantine";
    label = "spam";
    reason = "Moderate threat indicators; held for review.";
  } else {
    verdict = "allow";
    label = "ham";
    reason = "No significant threat indicators.";
  }

  res.json({
    verdict,
    confidence: Math.min(total / 15, 1),
    label,
    threat_score: total,
    reason,
    threats: [{ category: "aggregate", score: total }],
    signals_fired: signals,
    iocs: { urls: [], domains: [], ips: [], hashes: [] },
    actions_taken: [verdict],
    pipeline: {},
    metadata: { model_version: "synth-stub-0.1" },
  });
});

const port = Number(process.env.PORT || 80);
app.listen(port, () => console.log(`[synthesizer] listening on :${port}`));
