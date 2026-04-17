// E2 SLM classifier — Phase 1 stub with extended feature vector.
//
// Per PRD §7.2 the SLM feature vector is (174 rspamd symbols + rspamd_score
// + received_hops + has_attachment = 177) extended to 213 with Stats DB
// signals. The real model lives at /Users/kratikal/spam-classifier/small-model/
// (1.9M-param transformer). This stub produces signals from:
//   - URGENCY_LANGUAGE (body text tokens)
//   - RSPAMD_REASONED_PHISH (fires when rspamd upstream flagged DMARC/SPF
//     fail AND body has urgency tokens — the kind of cross-signal reasoning
//     the full SLM does natively)
import { makeApp, listen } from "@etdp/shared/engineBase";

const URGENCY_TOKENS = ["urgent", "immediately", "asap", "wire transfer", "gift card", "verify now"];

function analyze(email) {
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const hits = URGENCY_TOKENS.filter((t) => text.includes(t));
  const signals = [];
  if (hits.length > 0) {
    signals.push({
      engine: "slm", signal: "URGENCY_LANGUAGE",
      score: 1.5 * hits.length, detail: { tokens: hits },
    });
  }

  // Cross-signal reasoning: if rspamd upstream flagged auth failure AND
  // the body has urgency language, emit a high-confidence phishing signal.
  const priors = email.prior_signals || [];
  const authFailed = priors.some((s) =>
    /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));
  if (authFailed && hits.length > 0) {
    signals.push({
      engine: "slm", signal: "RSPAMD_REASONED_PHISH",
      score: 3.0,
      detail: { auth_signals: priors.filter((s) => /DMARC|SPF|PHISH/i.test(s.signal)).map((s) => s.signal), urgency_tokens: hits },
    });
  }

  return signals;
}

const app = makeApp("e2_slm", analyze);
listen(app, "e2_slm");
