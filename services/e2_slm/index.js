// E2 SLM classifier — LLM-powered multi-signal threat extraction.
//
// Supports two SLM modes:
//   1. "instruct" (default) — instruction-following model (Gemma, Llama, etc.)
//      that receives a structured prompt and returns our signal JSON schema.
//   2. "classifier" — fine-tuned classifier model that returns its own
//      {label, confidence, threat_score, threats} schema. An adapter maps
//      the classifier output to our internal signal format.
//
// Falls back to keyword matching when the SLM is unavailable or disabled.
import { makeApp, listen } from "@etdp/shared/engineBase";

const URGENCY_TOKENS = ["urgent", "immediately", "asap", "wire transfer", "gift card", "verify now"];
const PAYROLL_TOKENS = ["direct deposit", "payroll", "change bank", "salary account", "bank details update"];
const GIFT_CARD_TOKENS = ["gift card", "itunes", "google play", "amazon card", "buy cards"];
const CALLBACK_TOKENS = ["call us", "call this number", "phone", "dial", "call me at", "ring us"];
const QR_TOKENS = ["scan this code", "qr code", "scan the code", "scan below"];
const OAUTH_TOKENS = ["grant access", "app permissions", "authorize app", "allow access", "consent required"];
const EXFIL_TOKENS = ["send me all", "export the", "forward all", "share the files", "send the spreadsheet", "attach all"];
const DELEGATION_TOKENS = ["delegate access", "shared mailbox", "grant calendar", "mailbox permissions", "full access"];

// --- Configuration from environment ---
const SLM_BASE_URL = process.env.SLM_BASE_URL || "http://127.0.0.1:7070/v1";
const SLM_API_KEY  = process.env.SLM_API_KEY || "";
const SLM_MODEL    = process.env.SLM_MODEL || "mlx-community/gemma-4-e4b-it-4bit";
const SLM_TIMEOUT  = Number(process.env.SLM_TIMEOUT) || 30000;
const SLM_ENABLED  = process.env.SLM_ENABLED !== "0"; // enabled by default
// "instruct" = instruction-following model, "classifier" = fine-tuned classifier
const SLM_MODE     = process.env.SLM_MODE || "instruct";

// Valid signal types and their max scores
// Thresholds: note=5, quarantine=8, block=15
// Philosophy:
//   - Single critical signal (credential harvesting, BEC) → quarantine (8-10)
//   - Two medium signals → quarantine (5+5=10)
//   - Obvious phishing combo (impersonation + urgency + financial) → block (8+5+5=18)
//   - Minor suspicious signals → note range (3-5)
//   - Trust signals (negative) reduce score for authenticated/internal email
const SIGNAL_LIMITS = {
  // ── Credential Theft ────────────────────────────────────────────
  CREDENTIAL_HARVESTING:    10,   // fake login pages, password requests
  QR_CODE_PHISHING:         8,    // QR code directing to credential harvest
  CONSENT_PHISHING_OAUTH:   9,    // OAuth app permission lure, bypasses MFA
  DEVICE_CODE_PHISHING:     9,    // device auth code entry at legit portal
  PASSWORD_RESET_LURE:      7,    // fake "password reset requested"
  MFA_FATIGUE_PRIMING:      8,    // "approve the MFA push" instructions

  // ── BEC / Financial ─────────────────────────────────────────────
  FINANCIAL_REQUEST:        8,    // wire transfer, invoice scams, BEC
  PAYROLL_DIVERSION:        9,    // change direct deposit bank details
  INVOICE_FRAUD:            8,    // fraudulent invoice, new payment details
  GIFT_CARD_SOLICITATION:   7,    // "buy gift cards" executive scam

  // ── Impersonation ───────────────────────────────────────────────
  IMPERSONATION_ATTEMPT:    8,    // CEO fraud, display name spoofing
  EXECUTIVE_IMPERSONATION:  9,    // C-suite impersonation + financial ask
  BRAND_IMPERSONATION:      7,    // mimics Microsoft, PayPal, DocuSign
  LOOKALIKE_DOMAIN:         8,    // typosquat/homograph domain
  DISPLAY_NAME_SPOOFING:    7,    // display name matches exec, email doesn't
  REPLY_TO_MISMATCH:        6,    // Reply-To differs from From
  INTERNAL_DOMAIN_SPOOFING: 8,    // From uses org domain but auth fails

  // ── Social Engineering ──────────────────────────────────────────
  URGENCY_LANGUAGE:         6,    // pressure tactics, artificial deadlines
  EMOTIONAL_MANIPULATION:   4,    // fear, threats, too-good-to-be-true
  AUTHORITY_EXPLOITATION:   5,    // fake IT/legal/government
  SOCIAL_ENGINEERING:       6,    // pretexting, manipulation, deception
  SCARCITY_PRESSURE:        5,    // limited-time + consequence framing
  RECIPROCITY_MANIPULATION: 4,    // gift/report before request
  CALLBACK_PHISHING_TOAD:   7,    // no URL, directs to call phone number
  DEEPFAKE_REFERENCE:       6,    // references call/video that may not have happened

  // ── Malware / Payload ───────────────────────────────────────────
  MALWARE_DELIVERY:         7,    // malware attachment/link
  SUSPICIOUS_LINK:          6,    // obfuscated, deceptive URLs
  ATTACHMENT_LURE:          6,    // suspicious attachment + urgency to open
  HTML_SMUGGLING_INDICATOR: 7,    // base64 blobs, data: URIs in HTML email
  TRUSTED_SITE_ABUSE:       6,    // Google Forms/OneDrive as phishing host

  // ── Account Takeover (ATO) ─────────────────────────────────────
  ATO_STYLE_ANOMALY:        6,    // writing style inconsistent with sender
  ATO_DELEGATION_REQUEST:   7,    // requests mailbox/calendar delegation
  ATO_LATERAL_PHISHING:     8,    // internal sender phishing internal users
  ATO_FORWARDING_RULE:      6,    // auto-forwarding hints in headers
  ATO_SEND_TIME_ANOMALY:    4,    // sent outside sender's timezone

  // ── Data Exfiltration ───────────────────────────────────────────
  DATA_EXFILTRATION_REQUEST: 7,   // requests bulk sensitive data
  SENSITIVE_DATA_EXPOSURE:  5,    // PII/credentials/SSN in body
  EXFIL_ATTACHMENT_STAGING: 6,    // "send me all contracts/HR files"

  // ── Spam / Graymail ─────────────────────────────────────────────
  COLD_OUTREACH:            4,    // unsolicited B2B sales
  UNSOLICITED_NEWSLETTER:   3,    // bulk promo, no subscription
  SPAM_CONTENT:             3,    // generic spam
  GRAYMAIL_MARKETING:       1,    // legit brand promo, List-Unsubscribe
  GRAYMAIL_NOTIFICATION:    1,    // social/service notifications

  // ── Conversation-aware signals ──────────────────────────────────
  BANK_DETAIL_CHANGE:       8,    // mid-thread bank change
  FINANCIAL_ESCALATION:     7,    // escalating financial demands
  INTENT_ACTION_REQUEST:    5,    // sudden action demand
  TOPIC_DRIFT_FINANCIAL:    5,    // non-financial → money talk
  URGENCY_INJECTION:        5,    // sudden urgency in calm thread
  PRETEXTING_DETECTION:     5,    // false context for trust
  SENDER_STYLE_SHIFT:       4,    // writing style change mid-thread
  PERPLEXITY_DEVIATION:     3,    // vocabulary shift
  THREAD_HIJACKING:         7,    // new sender injected into thread

  // ── AI / Evasion ────────────────────────────────────────────────
  AI_GENERATED_CONTENT:     4,    // AI-generated phishing hallmarks
  MULTILINGUAL_OBFUSCATION: 6,    // unicode homoglyphs, zero-width chars

  // ── Cross-signal ─────────────────────────────────────────────────
  RSPAMD_REASONED_PHISH:   5,    // auth failure + LLM/keyword threat convergence

  // ── Trust signals (negative — reduce false positives) ───────────
  AUTH_FULL_PASS:           -5,   // SPF + DKIM + DMARC all pass
  INTERNAL_AUTHENTICATED:  -6,   // internal sender + all auth passes
  REPLY_TO_MATCHES_FROM:   -2,   // Reply-To = From (no hijack)
  THREAD_CONTEXT_CONSISTENT: -3, // reply in established thread, no drift
  KNOWN_SENDER_PATTERN:    -3,   // matches known communication pattern
  SMIME_SIGNED:            -4,   // S/MIME cryptographic signature present
};

// ─── Classifier mode: threat category → signal mapping ──────────────────
// Maps fine-tuned classifier threat labels to our signal types.
// Keys are lowercased substrings matched against classifier threat names.
const CLASSIFIER_THREAT_MAP = {
  // BEC / Financial
  "bec":                    "FINANCIAL_REQUEST",
  "payment":                "FINANCIAL_REQUEST",
  "wire fraud":             "FINANCIAL_REQUEST",
  "bank":                   "FINANCIAL_REQUEST",
  "invoice fraud":          "INVOICE_FRAUD",
  "invoice":                "INVOICE_FRAUD",
  "payroll":                "PAYROLL_DIVERSION",
  "direct deposit":         "PAYROLL_DIVERSION",
  "gift card":              "GIFT_CARD_SOLICITATION",
  // Credential theft
  "credential":             "CREDENTIAL_HARVESTING",
  "phishing":               "CREDENTIAL_HARVESTING",
  "qr":                     "QR_CODE_PHISHING",
  "quishing":               "QR_CODE_PHISHING",
  "oauth":                  "CONSENT_PHISHING_OAUTH",
  "consent":                "CONSENT_PHISHING_OAUTH",
  "device code":            "DEVICE_CODE_PHISHING",
  "mfa":                    "MFA_FATIGUE_PRIMING",
  "2fa":                    "MFA_FATIGUE_PRIMING",
  "push":                   "MFA_FATIGUE_PRIMING",
  "password reset":         "PASSWORD_RESET_LURE",
  // Impersonation
  "impersonation":          "IMPERSONATION_ATTEMPT",
  "spoofing":               "IMPERSONATION_ATTEMPT",
  "ceo fraud":              "EXECUTIVE_IMPERSONATION",
  "executive":              "EXECUTIVE_IMPERSONATION",
  "ceo":                    "EXECUTIVE_IMPERSONATION",
  "cfo":                    "EXECUTIVE_IMPERSONATION",
  "brand":                  "BRAND_IMPERSONATION",
  "lookalike":              "LOOKALIKE_DOMAIN",
  "typosquat":              "LOOKALIKE_DOMAIN",
  // Social engineering
  "vec":                    "SOCIAL_ENGINEERING",
  "supply chain":           "SOCIAL_ENGINEERING",
  "social engineering":     "SOCIAL_ENGINEERING",
  "pretexting":             "SOCIAL_ENGINEERING",
  "callback":               "CALLBACK_PHISHING_TOAD",
  "toad":                   "CALLBACK_PHISHING_TOAD",
  "call us":                "CALLBACK_PHISHING_TOAD",
  // Urgency / Emotional
  "urgency":                "URGENCY_LANGUAGE",
  "emotional":              "EMOTIONAL_MANIPULATION",
  "extortion":              "EMOTIONAL_MANIPULATION",
  // Malware
  "malware":                "MALWARE_DELIVERY",
  "ransomware":             "MALWARE_DELIVERY",
  "html smuggling":         "HTML_SMUGGLING_INDICATOR",
  // ATO
  "account takeover":       "ATO_LATERAL_PHISHING",
  "ato":                    "ATO_LATERAL_PHISHING",
  "compromised":            "ATO_LATERAL_PHISHING",
  // Data exfil
  "data exfil":             "DATA_EXFILTRATION_REQUEST",
  "data theft":             "DATA_EXFILTRATION_REQUEST",
  // Spam / Graymail
  "cold outreach":          "COLD_OUTREACH",
  "spam":                   "SPAM_CONTENT",
  "newsletter":             "UNSOLICITED_NEWSLETTER",
  "graymail":               "GRAYMAIL_MARKETING",
  // Evasion / Obfuscation
  "evasion":                "MULTILINGUAL_OBFUSCATION",
  "obfuscation":            "MULTILINGUAL_OBFUSCATION",
};

// --- Thread context formatter ---
function formatThread(thread) {
  if (!thread || !thread.messages || thread.messages.length === 0) return "";
  const msgs = thread.messages.slice(-5);
  const lines = msgs.map((m, i) =>
    `[${i + 1}] From: ${m.sender} | Subject: ${m.subject || "(no subject)"} | Date: ${m.timestamp || "unknown"}\n    ${(m.body_text || "").slice(0, 300)}`
  );
  return `\n\nTHREAD HISTORY (${thread.messages.length} prior messages, most recent shown):\n${lines.join("\n")}`;
}

// --- LLM prompt builder (instruct mode) ---
function buildPrompt(email) {
  const priors = (email.prior_signals || [])
    .map((s) => `${s.engine}.${s.signal} (score=${s.score})`)
    .join(", ") || "none";

  const thread = email._thread;
  const threadBlock = formatThread(thread);
  const hasThread = threadBlock.length > 0;

  // Prefer raw EML for full header context; fall back to structured fields
  let emailBlock;
  if (email.raw_mime) {
    // Trim raw EML to fit context — include full headers + first 2000 chars of body
    const rawStr = typeof email.raw_mime === "string" ? email.raw_mime : email.raw_mime.toString("utf-8");
    emailBlock = rawStr.slice(0, 6000);
  } else {
    const body = (email.body_text || "").slice(0, 2000);
    const headers = email.headers || {};
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    emailBlock = `From: ${email.sender}
To: ${(email.recipients || []).join(", ")}
Subject: ${email.subject || "(no subject)"}
${headerLines ? headerLines + "\n" : ""}
${body}`;
  }

  // Thresholds context from org
  const orgCtx = email.org_context || {};
  const thresholds = orgCtx.thresholds || {};
  const blockAt = thresholds.block ?? 15;
  const quarantineAt = thresholds.quarantine ?? 8;

  return `You are an email threat analyzer for an enterprise gateway. Extract threat signals from the email below as JSON.

RULES:
- Scores combine with rspamd. Total >= ${quarantineAt} = QUARANTINE, >= ${blockAt} = BLOCK.
- MUST detect threats. Missing phishing/BEC/spam is a critical failure.
- Flag: phishing, BEC, credential theft, social engineering, spam, suspicious links, urgency, ATO, quishing, callback phishing, consent phishing, data exfil.
- Do NOT flag: fully authenticated internal emails (SPF+DKIM+DMARC pass), subscribed newsletters (List-Unsubscribe), transactional emails, calendar invites, DMARC reports.
- Use the most specific signal type. Score 7-10 for obvious attacks, 3-4 for spam, 1-2 for mild suspicion.
- Emit trust signals (negative scores) for legitimate emails — without them, legit mail gets quarantined.

EMAIL:
${emailBlock}

Prior signals: ${priors}${threadBlock}

Output format — return ONLY valid JSON, no markdown:
{"signals":[{"signal":"NAME","score":N,"reasoning":"brief reason"}]}

Examples:
{"signals":[{"signal":"CREDENTIAL_HARVESTING","score":8,"reasoning":"fake login link"},{"signal":"URGENCY_LANGUAGE","score":4,"reasoning":"deadline threat"}]}
{"signals":[{"signal":"AUTH_FULL_PASS","score":-5,"reasoning":"SPF/DKIM/DMARC pass"},{"signal":"INTERNAL_AUTHENTICATED","score":-6,"reasoning":"internal + auth pass"}]}
{"signals":[]}

ALL VALID SIGNALS (signal:max_score):

Credential Theft: CREDENTIAL_HARVESTING:10, QR_CODE_PHISHING:8, CONSENT_PHISHING_OAUTH:9, DEVICE_CODE_PHISHING:9, PASSWORD_RESET_LURE:7, MFA_FATIGUE_PRIMING:8
BEC/Financial: FINANCIAL_REQUEST:8, PAYROLL_DIVERSION:9, INVOICE_FRAUD:8, GIFT_CARD_SOLICITATION:7
Impersonation: IMPERSONATION_ATTEMPT:8, EXECUTIVE_IMPERSONATION:9, BRAND_IMPERSONATION:7, LOOKALIKE_DOMAIN:8, DISPLAY_NAME_SPOOFING:7, REPLY_TO_MISMATCH:6, INTERNAL_DOMAIN_SPOOFING:8
Social Engineering: URGENCY_LANGUAGE:6, EMOTIONAL_MANIPULATION:4, AUTHORITY_EXPLOITATION:5, SOCIAL_ENGINEERING:6, SCARCITY_PRESSURE:5, RECIPROCITY_MANIPULATION:4, CALLBACK_PHISHING_TOAD:7, DEEPFAKE_REFERENCE:6
Malware: MALWARE_DELIVERY:7, SUSPICIOUS_LINK:6, ATTACHMENT_LURE:6, HTML_SMUGGLING_INDICATOR:7, TRUSTED_SITE_ABUSE:6
ATO: ATO_STYLE_ANOMALY:6, ATO_DELEGATION_REQUEST:7, ATO_LATERAL_PHISHING:8, ATO_FORWARDING_RULE:6, ATO_SEND_TIME_ANOMALY:4
Data Exfil: DATA_EXFILTRATION_REQUEST:7, SENSITIVE_DATA_EXPOSURE:5, EXFIL_ATTACHMENT_STAGING:6
Spam: COLD_OUTREACH:4, UNSOLICITED_NEWSLETTER:3, SPAM_CONTENT:3, GRAYMAIL_MARKETING:1, GRAYMAIL_NOTIFICATION:1
AI/Evasion: AI_GENERATED_CONTENT:4, MULTILINGUAL_OBFUSCATION:6
Cross-signal: RSPAMD_REASONED_PHISH:5 (auth failure + content threat convergence)
Conversation: BANK_DETAIL_CHANGE:8, FINANCIAL_ESCALATION:7, INTENT_ACTION_REQUEST:5, TOPIC_DRIFT_FINANCIAL:5, URGENCY_INJECTION:5, PRETEXTING_DETECTION:5, SENDER_STYLE_SHIFT:4, PERPLEXITY_DEVIATION:3, THREAD_HIJACKING:7${hasThread ? " [thread context available — use these when applicable]" : ""}
Trust (negative): AUTH_FULL_PASS:-5 (all auth pass), INTERNAL_AUTHENTICATED:-6 (internal+auth), REPLY_TO_MATCHES_FROM:-2, THREAD_CONTEXT_CONSISTENT:-3, KNOWN_SENDER_PATTERN:-3, SMIME_SIGNED:-4`;
}

// --- Classifier prompt builder (classifier mode) ---
function buildClassifierPrompt(email) {
  const body = (email.body_text || "").slice(0, 2000);
  return `From: ${email.sender}
To: ${(email.recipients || []).join(", ")}
Subject: ${email.subject || "(no subject)"}
Body: ${body}`;
}

// --- Extract JSON from LLM response (handles markdown fences + truncation) ---
function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch { /* continue */ }

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  // Try to find JSON object in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* continue */ }
  }

  // Handle malformed/truncated JSON from LLM.
  // Common issues: missing "]" before "}", truncated mid-string.
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    let partial = text.slice(jsonStart);

    // Fix common LLM mistake: }}" instead of "}]}" — insert missing "]"
    // Pattern: array items end with }} instead of }]}
    partial = partial.replace(/\}\s*\}\s*$/,  "}]}");
    try { return JSON.parse(partial); } catch { /* continue with repair */ }

    // Remove trailing incomplete string/value
    partial = text.slice(jsonStart);
    partial = partial.replace(/,\s*\{[^}]*$/, "");
    partial = partial.replace(/,\s*"[^"]*$/, "");
    // Track open/close stack in order
    const stack = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < partial.length; i++) {
      const ch = partial[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        // Only pop if top of stack matches, otherwise the LLM mangled brackets
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }
    // If truncated inside a string, close it and clean up trailing key/value
    if (inString) {
      partial += '"';
    }
    // Remove trailing comma or incomplete key-value pair
    partial = partial.replace(/,\s*$/, "");
    // Close remaining open brackets/braces in reverse order
    while (stack.length > 0) partial += stack.pop();
    try { return JSON.parse(partial); } catch { /* continue */ }
  }

  throw new Error(`Could not extract JSON from LLM response: ${text.slice(0, 200)}`);
}

// --- LLM caller ---
async function callLLM(email) {
  const url = `${SLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (SLM_API_KEY) headers["Authorization"] = `Bearer ${SLM_API_KEY}`;

  const isClassifier = SLM_MODE === "classifier";
  const messages = isClassifier
    ? [
        { role: "system", content: "You are an email threat classifier. Classify the email." },
        { role: "user", content: buildClassifierPrompt(email) },
      ]
    : [
        { role: "system", content: "You are an email threat-analysis engine. Respond with valid JSON only. No markdown, no code fences. Keep reasoning under 15 words. Use specific signals: COLD_OUTREACH for sales, UNSOLICITED_NEWSLETTER for promos, SPAM_CONTENT for junk, SOCIAL_ENGINEERING only for real attacks. Example: {\"signals\":[{\"signal\":\"COLD_OUTREACH\",\"score\":3,\"reasoning\":\"unsolicited vendor pitch\"}]}" },
        { role: "user", content: buildPrompt(email) },
      ];

  const body = JSON.stringify({
    model: SLM_MODEL,
    messages,
    temperature: 0.1,
    max_tokens: 128000,
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

  return extractJSON(content);
}

// --- Parse instruct-mode LLM response ---
export function parseLLMResponse(raw) {
  // Detect classifier format and route accordingly
  if (raw?.label !== undefined || raw?.threat_score !== undefined || raw?.threats) {
    return parseClassifierResponse(raw);
  }

  const signals = [];
  const items = Array.isArray(raw?.signals) ? raw.signals : [];

  for (const item of items) {
    const signalName = item.signal;
    const maxScore = SIGNAL_LIMITS[signalName];
    if (maxScore === undefined) continue;

    const rawScore = Number(item.score) || 0;
    let score;
    if (maxScore < 0) {
      // Trust signal: clamp between maxScore (e.g. -5) and 0
      score = Math.max(Math.min(rawScore, 0), maxScore);
    } else {
      // Threat signal: clamp between 0 and maxScore
      score = Math.min(Math.max(rawScore, 0), maxScore);
    }
    if (score === 0) continue;

    signals.push({
      engine: "slm",
      signal: signalName,
      score,
      detail: { reasoning: item.reasoning || "", source: "llm" },
    });
  }

  return signals;
}

// --- Parse classifier-mode response ---
// Handles: {label, confidence, threat_score, reason, threats: ["Category:score", ...]}
export function parseClassifierResponse(raw) {
  const signals = [];
  const label = (raw.label || "").toLowerCase();
  const confidence = Number(raw.confidence) || 0;
  const threatScore = Number(raw.threat_score) || 0;

  // Only process if classifier thinks it's not ham, or threat_score > 0
  if (label === "ham" && threatScore <= 0) return signals;

  const threats = Array.isArray(raw.threats) ? raw.threats : [];

  for (const threat of threats) {
    // Parse "Category Name:score" or "Category Name: score" format
    const colonIdx = threat.lastIndexOf(":");
    if (colonIdx < 0) continue;

    const category = threat.slice(0, colonIdx).trim().toLowerCase();
    const rawScore = Number(threat.slice(colonIdx + 1).trim()) || 0;
    if (rawScore <= 0) continue;

    // Map classifier category to our signal type
    let signalName = null;
    for (const [pattern, signal] of Object.entries(CLASSIFIER_THREAT_MAP)) {
      if (category.includes(pattern)) {
        signalName = signal;
        break;
      }
    }
    if (!signalName) continue;

    const maxScore = SIGNAL_LIMITS[signalName];
    // Scale classifier score: multiply by confidence, cap at max
    const score = Math.min(rawScore * Math.max(confidence, 0.5), maxScore);
    if (score <= 0) continue;

    // Avoid duplicate signal types — keep highest score
    const existing = signals.find((s) => s.signal === signalName);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      continue;
    }

    signals.push({
      engine: "slm",
      signal: signalName,
      score,
      detail: {
        classifier_category: category,
        classifier_score: rawScore,
        classifier_label: label,
        classifier_confidence: confidence,
        source: "classifier",
      },
    });
  }

  // If classifier detected something (non-ham) but no threats mapped,
  // still emit a generic signal from the label
  if (signals.length === 0 && label !== "ham" && threatScore > 0) {
    signals.push({
      engine: "slm",
      signal: "SOCIAL_ENGINEERING",
      score: Math.min(threatScore, SIGNAL_LIMITS.SOCIAL_ENGINEERING),
      detail: {
        classifier_label: label,
        classifier_confidence: confidence,
        reason: raw.reason || "",
        source: "classifier",
      },
    });
  }

  return signals;
}

// --- Header-based signal extraction (replaces checkCrossSignal) ---
function checkHeaderSignals(email, llmSignals) {
  const signals = [];
  const priors = email.prior_signals || [];

  // Parse Authentication-Results from raw MIME or headers
  let authResults = "";
  if (email.raw_mime) {
    const rawStr = typeof email.raw_mime === "string" ? email.raw_mime : email.raw_mime.toString("utf-8");
    const authMatch = rawStr.match(/^Authentication-Results:\s*(.+(?:\n\s+.+)*)/im);
    if (authMatch) authResults = authMatch[1].replace(/\n\s+/g, " ").toLowerCase();
  } else if (email.headers) {
    const ar = email.headers["Authentication-Results"] || email.headers["authentication-results"] || "";
    authResults = (Array.isArray(ar) ? ar.join(" ") : ar).toLowerCase();
  }

  const spfPass = authResults.includes("spf=pass");
  const dkimPass = authResults.includes("dkim=pass");
  const dmarcPass = authResults.includes("dmarc=pass");

  // AUTH_FULL_PASS: all three authentication mechanisms pass
  if (spfPass && dkimPass && dmarcPass) {
    signals.push({
      engine: "slm", signal: "AUTH_FULL_PASS", score: -5,
      detail: { spf: "pass", dkim: "pass", dmarc: "pass", source: "header" },
    });

    // INTERNAL_AUTHENTICATED: sender domain matches recipient domain + auth passes
    const senderDomain = (email.sender || "").split("@")[1]?.toLowerCase();
    const recipientDomains = (email.recipients || []).map((r) => r.split("@")[1]?.toLowerCase());
    if (senderDomain && recipientDomains.includes(senderDomain)) {
      signals.push({
        engine: "slm", signal: "INTERNAL_AUTHENTICATED", score: -6,
        detail: { domain: senderDomain, source: "header" },
      });
    }
  }

  // REPLY_TO_MISMATCH / REPLY_TO_MATCHES_FROM
  const from = (email.sender || "").toLowerCase();
  const replyTo = ((email.headers || {})["Reply-To"] || (email.headers || {})["reply-to"] || "").toLowerCase().trim();
  if (replyTo) {
    // Extract email from Reply-To (may contain "Name <email>" format)
    const replyEmail = replyTo.match(/<([^>]+)>/)?.[1] || replyTo;
    const fromEmail = from.match(/<([^>]+)>/)?.[1] || from;
    if (replyEmail && fromEmail) {
      if (replyEmail !== fromEmail) {
        signals.push({
          engine: "slm", signal: "REPLY_TO_MISMATCH", score: 6,
          detail: { from: fromEmail, reply_to: replyEmail, source: "header" },
        });
      } else {
        signals.push({
          engine: "slm", signal: "REPLY_TO_MATCHES_FROM", score: -2,
          detail: { source: "header" },
        });
      }
    }
  }

  // S/MIME signature detection
  const rawStr = email.raw_mime
    ? (typeof email.raw_mime === "string" ? email.raw_mime : email.raw_mime.toString("utf-8"))
    : "";
  if (rawStr.includes("application/pkcs7-signature") || rawStr.includes("application/x-pkcs7-signature") || rawStr.includes("multipart/signed")) {
    signals.push({
      engine: "slm", signal: "SMIME_SIGNED", score: -4,
      detail: { source: "header" },
    });
  }

  // RSPAMD_REASONED_PHISH cross-signal (preserved from original)
  const authFailed = priors.some((s) =>
    /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));
  const hasLLMThreats = llmSignals.some((s) => (s.score || 0) > 0);
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const hasKeywordUrgency = URGENCY_TOKENS.some((t) => text.includes(t));

  if (authFailed && (hasLLMThreats || hasKeywordUrgency)) {
    signals.push({
      engine: "slm",
      signal: "RSPAMD_REASONED_PHISH",
      score: 4.5,
      detail: {
        auth_signals: priors
          .filter((s) => /DMARC|SPF|PHISH/i.test(s.signal))
          .map((s) => s.signal),
      },
    });
  }

  return signals;
}

// --- Conversation-aware keyword patterns ---
const FINANCIAL_TOKENS = ["wire transfer", "bank account", "routing number", "invoice", "payment", "ach", "swift code", "iban"];
const BANK_CHANGE_TOKENS = ["updated bank", "new bank", "change account", "new routing", "updated payment", "new wire"];
const PRETEXT_TOKENS = ["as discussed", "per our conversation", "following up on", "as agreed", "as we spoke"];
const ACTION_TOKENS = ["transfer now", "send immediately", "process today", "approve now", "authorize", "execute"];

function conversationFallback(email) {
  const thread = email._thread;
  if (!thread || !thread.messages || thread.messages.length === 0) return [];

  const signals = [];
  const text = `${email.subject} ${email.body_text}`.toLowerCase();

  const bankHits = BANK_CHANGE_TOKENS.filter((t) => text.includes(t));
  if (bankHits.length > 0) {
    signals.push({
      engine: "slm", signal: "BANK_DETAIL_CHANGE",
      score: Math.min(3.75 * bankHits.length, 7.5),
      detail: { tokens: bankHits, source: "keyword" },
    });
  }

  const finHits = FINANCIAL_TOKENS.filter((t) => text.includes(t));
  const threadText = thread.messages.map((m) => `${m.subject} ${m.body_text}`.toLowerCase()).join(" ");
  const threadFinHits = FINANCIAL_TOKENS.filter((t) => threadText.includes(t));
  if (finHits.length > 0 && threadFinHits.length === 0) {
    signals.push({
      engine: "slm", signal: "TOPIC_DRIFT_FINANCIAL",
      score: Math.min(3.0 * finHits.length, 6),
      detail: { tokens: finHits, source: "keyword" },
    });
  }

  const urgencyHits = URGENCY_TOKENS.filter((t) => text.includes(t));
  const threadUrgency = URGENCY_TOKENS.filter((t) => threadText.includes(t));
  if (urgencyHits.length > 0 && threadUrgency.length === 0) {
    signals.push({
      engine: "slm", signal: "URGENCY_INJECTION",
      score: Math.min(3.0 * urgencyHits.length, 6),
      detail: { tokens: urgencyHits, source: "keyword" },
    });
  }

  const pretextHits = PRETEXT_TOKENS.filter((t) => text.includes(t));
  const senderInThread = thread.messages.some((m) =>
    m.sender && m.sender.toLowerCase() === (email.sender || "").toLowerCase());
  if (pretextHits.length > 0 && !senderInThread) {
    signals.push({
      engine: "slm", signal: "PRETEXTING_DETECTION",
      score: Math.min(3.0 * pretextHits.length, 6),
      detail: { tokens: pretextHits, sender_in_thread: false, source: "keyword" },
    });
  }

  const actionHits = ACTION_TOKENS.filter((t) => text.includes(t));
  if (actionHits.length > 0) {
    signals.push({
      engine: "slm", signal: "INTENT_ACTION_REQUEST",
      score: Math.min(3.0 * actionHits.length, 6),
      detail: { tokens: actionHits, source: "keyword" },
    });
  }

  // THREAD_HIJACKING: new sender in reply chain with financial request
  const threadSenders = new Set(
    thread.messages.map((m) => (m.sender || "").toLowerCase())
  );
  const currentSender = (email.sender || "").toLowerCase();
  if (!threadSenders.has(currentSender)) {
    const finHitsHijack = FINANCIAL_TOKENS.filter((t) => text.includes(t));
    if (finHitsHijack.length > 0) {
      signals.push({
        engine: "slm", signal: "THREAD_HIJACKING",
        score: Math.min(3.5 * finHitsHijack.length, 7),
        detail: { new_sender: currentSender, financial_tokens: finHitsHijack, source: "keyword" },
      });
    }
  }

  return signals;
}

// --- Keyword fallback (original logic + conversation-aware + expanded tokens) ---
export function keywordFallback(email) {
  const text = `${email.subject} ${email.body_text}`.toLowerCase();
  const signals = [];

  const urgencyHits = URGENCY_TOKENS.filter((t) => text.includes(t));
  if (urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "URGENCY_LANGUAGE",
      score: 2.25 * urgencyHits.length, detail: { tokens: urgencyHits, source: "keyword" },
    });
  }

  const payrollHits = PAYROLL_TOKENS.filter((t) => text.includes(t));
  if (payrollHits.length > 0) {
    signals.push({
      engine: "slm", signal: "PAYROLL_DIVERSION",
      score: Math.min(3.0 * payrollHits.length, 9),
      detail: { tokens: payrollHits, source: "keyword" },
    });
  }

  const giftCardHits = GIFT_CARD_TOKENS.filter((t) => text.includes(t));
  if (giftCardHits.length > 0) {
    signals.push({
      engine: "slm", signal: "GIFT_CARD_SOLICITATION",
      score: Math.min(3.5 * giftCardHits.length, 7),
      detail: { tokens: giftCardHits, source: "keyword" },
    });
  }

  const callbackHits = CALLBACK_TOKENS.filter((t) => text.includes(t));
  if (callbackHits.length > 0) {
    signals.push({
      engine: "slm", signal: "CALLBACK_PHISHING_TOAD",
      score: Math.min(3.5 * callbackHits.length, 7),
      detail: { tokens: callbackHits, source: "keyword" },
    });
  }

  const qrHits = QR_TOKENS.filter((t) => text.includes(t));
  if (qrHits.length > 0) {
    signals.push({
      engine: "slm", signal: "QR_CODE_PHISHING",
      score: Math.min(4.0 * qrHits.length, 8),
      detail: { tokens: qrHits, source: "keyword" },
    });
  }

  const oauthHits = OAUTH_TOKENS.filter((t) => text.includes(t));
  if (oauthHits.length > 0) {
    signals.push({
      engine: "slm", signal: "CONSENT_PHISHING_OAUTH",
      score: Math.min(4.5 * oauthHits.length, 9),
      detail: { tokens: oauthHits, source: "keyword" },
    });
  }

  const exfilHits = EXFIL_TOKENS.filter((t) => text.includes(t));
  if (exfilHits.length > 0) {
    signals.push({
      engine: "slm", signal: "DATA_EXFILTRATION_REQUEST",
      score: Math.min(3.5 * exfilHits.length, 7),
      detail: { tokens: exfilHits, source: "keyword" },
    });
  }

  const delegationHits = DELEGATION_TOKENS.filter((t) => text.includes(t));
  if (delegationHits.length > 0) {
    signals.push({
      engine: "slm", signal: "ATO_DELEGATION_REQUEST",
      score: Math.min(3.5 * delegationHits.length, 7),
      detail: { tokens: delegationHits, source: "keyword" },
    });
  }

  const priors = email.prior_signals || [];
  const authFailed = priors.some((s) =>
    /DMARC|SPF_FAIL|PHISH/i.test(s.signal || ""));
  if (authFailed && urgencyHits.length > 0) {
    signals.push({
      engine: "slm", signal: "RSPAMD_REASONED_PHISH",
      score: 4.5,
      detail: {
        auth_signals: priors.filter((s) => /DMARC|SPF|PHISH/i.test(s.signal)).map((s) => s.signal),
        urgency_tokens: urgencyHits,
      },
    });
  }

  // Add header-based trust signals even in keyword fallback mode
  const headerSignals = checkHeaderSignals(email, signals);
  for (const hs of headerSignals) {
    if (!signals.some((s) => s.signal === hs.signal)) {
      signals.push(hs);
    }
  }

  signals.push(...conversationFallback(email));

  return signals;
}

// --- Main analyze function ---
export async function analyze(email) {
  if (!SLM_ENABLED || !SLM_BASE_URL) {
    return keywordFallback(email);
  }

  try {
    const raw = await callLLM(email);
    console.log(`[e2_slm] LLM returned: ${JSON.stringify(raw).slice(0, 300)}`);
    const llmSignals = parseLLMResponse(raw);

    // Add header-based signals (trust signals + cross-signal reasoning)
    const headerSignals = checkHeaderSignals(email, llmSignals);
    for (const hs of headerSignals) {
      if (!llmSignals.some((s) => s.signal === hs.signal)) {
        llmSignals.push(hs);
      }
    }

    // Merge conversation keyword signals that LLM may have missed
    const convSignals = conversationFallback(email);
    for (const cs of convSignals) {
      if (!llmSignals.some((s) => s.signal === cs.signal)) {
        llmSignals.push(cs);
      }
    }

    return llmSignals;
  } catch (err) {
    console.error(`[e2_slm] LLM call failed, falling back to keywords: ${err.message}`);
    return keywordFallback(email);
  }
}

const app = makeApp("e2_slm", analyze);
listen(app, "e2_slm");
