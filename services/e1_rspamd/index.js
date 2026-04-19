// E1 rspamd — Phase 1 hardened: HTTP translator to a real rspamd daemon.
//
// Behavior:
//   - If RSPAMD_URL is set, build MIME from the Email schema, POST to
//     rspamd's /checkv2, translate each returned symbol into a Signal.
//   - Otherwise (or on error), fall back to the scaffold header-grep
//     mode so dev without an rspamd container keeps working.
//
// Rspamd docs: https://rspamd.com/doc/architecture/protocol.html#result
import { request } from "undici";
import { makeApp, listen } from "@etdp/shared/engineBase";

const RSPAMD_URL = process.env.RSPAMD_URL || "";
const RSPAMD_PASSWORD = process.env.RSPAMD_PASSWORD || "";

function buildMime(email) {
  const lines = [];
  lines.push(`From: ${email.sender}`);
  if (email.recipients?.length) lines.push(`To: ${email.recipients.join(", ")}`);
  lines.push(`Subject: ${email.subject || ""}`);
  lines.push(`Message-ID: ${email.message_id}`);
  lines.push(`Date: ${(email.received_at ? new Date(email.received_at) : new Date()).toUTCString()}`);
  for (const [k, v] of Object.entries(email.headers || {})) {
    // Skip headers we already set above.
    if (/^(from|to|subject|message-id|date)$/i.test(k)) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push(`MIME-Version: 1.0`);
  if (email.body_html) {
    const boundary = `====ETDP_${Date.now()}====`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push("");
    lines.push(email.body_text || "");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push("");
    lines.push(email.body_html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push("");
    lines.push(email.body_text || "");
  }
  return lines.join("\r\n");
}

async function callRspamd(email) {
  if (!RSPAMD_URL) throw new Error("RSPAMD_URL not configured");
  const mime = email.raw_mime || buildMime(email);
  const headers = {
    "Content-Type": email.raw_mime ? "message/rfc822" : "text/plain",
    "User-Agent": "etdp-e1/0.1",
    "Deliver-To": email.recipients?.[0] || "",
    "From": email.sender,
    "IP": email.headers?.["X-Forwarded-For"] || "127.0.0.1",
    "Message-Length": Buffer.byteLength(mime).toString(),
  };
  if (RSPAMD_PASSWORD) headers["Password"] = RSPAMD_PASSWORD;
  const { statusCode, body } = await request(`${RSPAMD_URL.replace(/\/$/, "")}/checkv2`, {
    method: "POST", headers, body: mime,
    bodyTimeout: 5_000, headersTimeout: 5_000,
  });
  const text = await body.text();
  if (statusCode >= 400) throw new Error(`rspamd ${statusCode}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

// Translate rspamd JSON → Signal[].
// Rspamd emits { score, action, symbols: { SYM_NAME: { name, score, description, options } } }.
function rspamdToSignals(rspamdResp) {
  const signals = [];
  const symbols = rspamdResp?.symbols || {};
  for (const name of Object.keys(symbols)) {
    const sym = symbols[name];
    const rawScore = Number(sym?.score || 0);
    // Raw score — engine scaling (default 1.5×) now applied in gateway aggregate()
    const score = rawScore;
    if (rawScore === 0 && !/^(BAYES_SPAM|BAYES_HAM)$/.test(name)) continue;
    signals.push({
      engine: "rspamd",
      signal: name,
      score,
      detail: {
        description: sym.description || null,
        options: sym.options || [],
      },
    });
  }
  // Add aggregate action + overall score.
  if (rspamdResp.action && rspamdResp.action !== "no action") {
    signals.push({
      engine: "rspamd",
      signal: `ACTION_${String(rspamdResp.action).toUpperCase().replace(/\s+/g, "_")}`,
      score: 0,
      detail: { total_score: Number(rspamdResp.score || 0) },
    });
  }
  return signals;
}

// Fallback header-grep (unchanged from Phase 0 scaffold).
function fallbackAnalyze(email) {
  const headers = JSON.stringify(email.headers || {}).toLowerCase();
  const signals = [];
  if (headers.includes("spf=fail")) {
    signals.push({ engine: "rspamd", signal: "SPF_FAIL", score: 3.0, detail: {} });
  }
  if (headers.includes("dmarc=fail")) {
    signals.push({ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 4.5, detail: {} });
  }
  return signals;
}

export async function analyze(email) {
  if (!RSPAMD_URL) return fallbackAnalyze(email);
  try {
    const resp = await callRspamd(email);
    const signals = rspamdToSignals(resp);
    return signals.length > 0 ? signals : fallbackAnalyze(email);
  } catch (err) {
    // Real rspamd unreachable — fall back, but annotate so it's visible.
    const fb = fallbackAnalyze(email);
    fb.push({
      engine: "rspamd", signal: "RSPAMD_FALLBACK",
      score: 0, detail: { reason: err.message.slice(0, 80) },
    });
    return fb;
  }
}

export { buildMime, rspamdToSignals, fallbackAnalyze };

const app = makeApp("e1_rspamd", analyze);
listen(app, "e1_rspamd");
