// E2 SLM classifier — Phase 2 extended feature vector.
//
// Per PRD §7.2 the SLM feature vector pulls in signals from rspamd (E1)
// AND from Stats DB (E3) + Graph DB (E4).  The real 1.9M-param model
// lives in a Python sidecar; this stub captures the same cross-signal
// reasoning the full model would perform, as additional signals gated
// on combinations of upstream evidence.
//
// Signals emitted by this stub:
//   URGENCY_LANGUAGE          — body contains urgency tokens
//   RSPAMD_REASONED_PHISH     — auth-fail AND urgency language
//   NEW_VENDOR_WIRE_REQUEST   — first-time sender AND wire/urgency tokens
//   EXEC_IMPERSONATION_TEXT   — display_name_mismatch AND urgency language
//   STATS_REASONED_BEC        — first_time_pair AND wire-transfer intent
//   GRAPH_REASONED_DIR_REVERSAL — direction_reversal AND payment change
//   FREEMAIL_BEC              — freemail_to_corp AND invoice/wire tokens
import { makeApp, listen } from "@etdp/shared/engineBase";

const URGENCY_TOKENS = ["urgent", "immediately", "asap", "wire transfer", "gift card", "verify now"];
const PAYMENT_TOKENS = ["wire", "ach", "bank transfer", "payment", "account details", "invoice", "remit"];
const CHANGE_TOKENS = ["change", "update", "new account", "new bank"];

function has(text, tokens) {
  const lc = text.toLowerCase();
  return tokens.filter((t) => lc.includes(t));
}

function priorMatches(priors, predicate) {
  return (priors || []).some(predicate);
}

export function analyze(email) {
  const text = `${email.subject} ${email.body_text}`;
  const priors = email.prior_signals || [];
  const signals = [];

  const urgencyHits = has(text, URGENCY_TOKENS);
  if (urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "URGENCY_LANGUAGE",
      score: 1.5 * urgencyHits.length, detail: { tokens: urgencyHits },
    });
  }

  const authFailed = priorMatches(priors,
    (s) => /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));
  if (authFailed && urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "RSPAMD_REASONED_PHISH", score: 3.0,
      detail: {
        auth_signals: priors.filter((s) => /DMARC|SPF|PHISH/i.test(s.signal)).map((s) => s.signal),
        urgency_tokens: urgencyHits,
      },
    });
  }

  // ── Extended reasoning over Stats DB priors ─────────────────────────
  const firstTimeSender = priorMatches(priors,
    (s) => s.engine === "stats_db" && s.signal === "first_time_sender");
  const firstTimePair = priorMatches(priors,
    (s) => s.engine === "stats_db" && s.signal === "first_time_pair");
  const freemailToCorp = priorMatches(priors,
    (s) => s.engine === "stats_db" && s.signal === "freemail_to_corp");
  const domainRecent = priorMatches(priors,
    (s) => s.engine === "stats_db" && /domain_first_seen/.test(s.signal));

  const paymentHits = has(text, PAYMENT_TOKENS);
  const changeHits = has(text, CHANGE_TOKENS);

  if (firstTimeSender && paymentHits.length > 0 && urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "NEW_VENDOR_WIRE_REQUEST", score: 3.5,
      detail: { payment_tokens: paymentHits, urgency_tokens: urgencyHits },
    });
  }

  if (firstTimePair && paymentHits.length > 0) {
    signals.push({
      engine: "slm", signal: "STATS_REASONED_BEC", score: 2.5,
      detail: { payment_tokens: paymentHits, reason: "payment to never-contacted recipient" },
    });
  }

  if (domainRecent && urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "YOUNG_DOMAIN_URGENCY", score: 2.0,
      detail: { urgency_tokens: urgencyHits, reason: "urgency from a domain we just met" },
    });
  }

  if (freemailToCorp && paymentHits.length > 0) {
    signals.push({
      engine: "slm", signal: "FREEMAIL_BEC", score: 2.5,
      detail: { payment_tokens: paymentHits, reason: "freemail sender asking for payment" },
    });
  }

  // ── Extended reasoning over Graph DB priors ─────────────────────────
  const vipMismatch = priorMatches(priors,
    (s) => s.engine === "graph_db" && /vip|executive/i.test(s.signal));
  const directionReversal = priorMatches(priors,
    (s) => s.engine === "graph_db" && s.signal === "direction_reversal");
  const firstTimeExternal = priorMatches(priors,
    (s) => s.engine === "graph_db" && s.signal === "first_time_external_sender");

  if (vipMismatch && urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "EXEC_IMPERSONATION_TEXT", score: 4.0,
      detail: { urgency_tokens: urgencyHits,
        reason: "VIP display-name match on unknown sender + urgency" },
    });
  }

  if (directionReversal && changeHits.length > 0) {
    signals.push({
      engine: "slm", signal: "GRAPH_REASONED_DIR_REVERSAL", score: 3.0,
      detail: { change_tokens: changeHits,
        reason: "counterparty is suddenly requesting changes" },
    });
  }

  if (firstTimeExternal && paymentHits.length > 0 && changeHits.length > 0) {
    signals.push({
      engine: "slm", signal: "VENDOR_EMAIL_COMPROMISE", score: 3.5,
      detail: { payment_tokens: paymentHits, change_tokens: changeHits },
    });
  }

  return signals;
}

const app = makeApp("e2_slm", analyze);
listen(app, "e2_slm");
