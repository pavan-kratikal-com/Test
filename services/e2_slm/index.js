// E2 SLM classifier stub. Real impl wraps the prototype 1.9M-param transformer
// (PRD Appendix C) — likely as a Python sidecar called over HTTP.
import { makeApp, listen } from "@etdp/shared/engineBase";

const URGENCY_TOKENS = ["urgent", "immediately", "asap", "wire transfer", "gift card"];

function analyze(email) {
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const hits = URGENCY_TOKENS.filter((t) => text.includes(t));
  if (hits.length === 0) return [];
  return [
    {
      engine: "slm",
      signal: "URGENCY_LANGUAGE",
      score: 1.5 * hits.length,
      detail: { tokens: hits },
    },
  ];
}

const app = makeApp("e2_slm", analyze);
listen(app, "e2_slm");
