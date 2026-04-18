// E2 SLM classifier — LLM-powered multi-signal threat extraction.
//
// Calls any OpenAI-compatible /v1/chat/completions endpoint to extract
// threat signals from email content. Falls back to keyword matching
// when the LLM is unavailable or disabled.
import { makeApp, listen } from "@etdp/shared/engineBase";

const URGENCY_TOKENS = ["urgent", "immediately", "asap", "wire transfer", "gift card", "verify now"];

// --- Configuration from environment ---
const SLM_BASE_URL = process.env.SLM_BASE_URL || "";
const SLM_API_KEY  = process.env.SLM_API_KEY || "";
const SLM_MODEL    = process.env.SLM_MODEL || "llama3";
const SLM_TIMEOUT  = Number(process.env.SLM_TIMEOUT) || 8000;
const SLM_ENABLED  = process.env.SLM_ENABLED === "1";

// Valid signal types and their max scores
const SIGNAL_LIMITS = {
  URGENCY_LANGUAGE:       9,
  IMPERSONATION_ATTEMPT:  7.5,
  FINANCIAL_REQUEST:      7.5,
  CREDENTIAL_HARVESTING:  6,
  EMOTIONAL_MANIPULATION: 4.5,
  SOCIAL_ENGINEERING:     6,
};

// --- LLM prompt builder ---
function buildPrompt(email) {
  const priors = (email.prior_signals || [])
    .map((s) => `${s.engine}.${s.signal} (score=${s.score})`)
    .join(", ") || "none";

  const body = (email.body_text || "").slice(0, 2000);

  return `You are an email threat-analysis engine. Analyze the following email and extract threat signals.

EMAIL:
From: ${email.sender}
To: ${(email.recipients || []).join(", ")}
Subject: ${email.subject || "(no subject)"}
Body: ${body}
Prior signals from upstream engines: ${priors}

For each threat signal you detect, return a JSON object with this exact structure:
{
  "signals": [
    {
      "signal": "<SIGNAL_TYPE>",
      "score": <number>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Valid signal types and their maximum scores:
- URGENCY_LANGUAGE (max 9): Urgency or pressure tactics
- IMPERSONATION_ATTEMPT (max 7.5): Sender pretending to be someone else
- FINANCIAL_REQUEST (max 7.5): Wire transfer, payment, invoice demands
- CREDENTIAL_HARVESTING (max 6): Asking for passwords, login, verification
- EMOTIONAL_MANIPULATION (max 4.5): Fear, threats, rewards to pressure action
- SOCIAL_ENGINEERING (max 6): Pretexting, authority exploitation

Only include signals you detect. If the email is benign, return {"signals": []}.
Return ONLY valid JSON, no markdown fences or extra text.`;
}

// --- LLM caller ---
async function callLLM(email) {
  const url = `${SLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (SLM_API_KEY) headers["Authorization"] = `Bearer ${SLM_API_KEY}`;

  const body = JSON.stringify({
    model: SLM_MODEL,
    messages: [{ role: "user", content: buildPrompt(email) }],
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: "json_object" },
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(SLM_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`LLM API returned ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response missing choices[0].message.content");

  return JSON.parse(content);
}

// --- Parse and validate LLM response ---
function parseLLMResponse(raw) {
  const signals = [];
  const items = Array.isArray(raw?.signals) ? raw.signals : [];

  for (const item of items) {
    const signalName = item.signal;
    const maxScore = SIGNAL_LIMITS[signalName];
    if (maxScore === undefined) continue; // unknown signal type, skip

    const score = Math.min(Math.max((Number(item.score) || 0) * 1.5, 0), maxScore);
    if (score <= 0) continue;

    signals.push({
      engine: "slm",
      signal: signalName,
      score,
      detail: { reasoning: item.reasoning || "", source: "llm" },
    });
  }

  return signals;
}

// --- Cross-signal: RSPAMD_REASONED_PHISH ---
function checkCrossSignal(email, llmSignals) {
  const priors = email.prior_signals || [];
  const authFailed = priors.some((s) =>
    /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));

  // Fire if rspamd auth failure AND (LLM detected threats OR keyword urgency)
  const hasLLMThreats = llmSignals.length > 0;
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const hasKeywordUrgency = URGENCY_TOKENS.some((t) => text.includes(t));

  if (authFailed && (hasLLMThreats || hasKeywordUrgency)) {
    return {
      engine: "slm",
      signal: "RSPAMD_REASONED_PHISH",
      score: 4.5,
      detail: {
        auth_signals: priors
          .filter((s) => /DMARC|SPF|PHISH/i.test(s.signal))
          .map((s) => s.signal),
      },
    };
  }
  return null;
}

// --- Keyword fallback (original logic) ---
export function keywordFallback(email) {
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const hits = URGENCY_TOKENS.filter((t) => text.includes(t));
  const signals = [];
  if (hits.length > 0) {
    signals.push({
      engine: "slm", signal: "URGENCY_LANGUAGE",
      score: 2.25 * hits.length, detail: { tokens: hits },
    });
  }

  const priors = email.prior_signals || [];
  const authFailed = priors.some((s) =>
    /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));
  if (authFailed && hits.length > 0) {
    signals.push({
      engine: "slm", signal: "RSPAMD_REASONED_PHISH",
      score: 4.5,
      detail: {
        auth_signals: priors.filter((s) => /DMARC|SPF|PHISH/i.test(s.signal)).map((s) => s.signal),
        urgency_tokens: hits,
      },
    });
  }

  return signals;
}

// --- Main analyze function ---
export async function analyze(email) {
  // Use keyword fallback if LLM is disabled or not configured
  if (!SLM_ENABLED || !SLM_BASE_URL) {
    return keywordFallback(email);
  }

  try {
    const raw = await callLLM(email);
    const llmSignals = parseLLMResponse(raw);

    // Add cross-signal reasoning
    const crossSignal = checkCrossSignal(email, llmSignals);
    if (crossSignal) llmSignals.push(crossSignal);

    return llmSignals;
  } catch (err) {
    console.error(`[e2_slm] LLM call failed, falling back to keywords: ${err.message}`);
    return keywordFallback(email);
  }
}

const app = makeApp("e2_slm", analyze);
listen(app, "e2_slm");
