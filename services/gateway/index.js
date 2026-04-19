// Gateway — Phase 1 complete.
//
// - Staged fanout: E1 (rspamd) runs first; its signals are forwarded into E2
//   (SLM) as prior_signals (PRD 6.2 dependency graph: rspamd → SLM).
// - Per-org registry lookup with thresholds, timezone, and ramp-weight.
// - Ramp: stats_db signals scale 0→1 over 30 days from org.onboarded_at.
// - Admin APIs: POST /v1/orgs, PUT /v1/orgs/:id/thresholds.
// - Management APIs: feedback, verdicts, stats (from Phase 1 first pass).

import fs from "fs";
import express from "express";
import { SMTPServer } from "smtp-server";
import { request } from "undici";
import { Email } from "@etdp/shared/schemas";
import { safeQuery, safeOrgQuery, provisionOrg } from "@etdp/shared/mysql";
import { cached } from "@etdp/shared/cache";
import { produce, kafkaEnabled, TOPIC_DEEP_PATH } from "@etdp/shared/kafka";
import { signalsToFeatures } from "@etdp/shared/features";
import { predictProba } from "@etdp/shared/logreg";
import { getDeployments } from "@etdp/shared/modelRegistry";
import { parseEml } from "@etdp/shared/emlParser";
import { renderStatusPage } from "./statusPage.js";
import { renderDashboardPage } from "./dashboardPage.js";
import { renderSignupPage } from "./signupPage.js";
import { renderLoginPage } from "./loginPage.js";
import {
  buildGoogleAuthUrl, handleGoogleCallback,
  buildMicrosoftAuthUrl, handleMicrosoftCallback,
  buildGoogleSsoUrl, handleGoogleSsoCallback,
  buildMicrosoftSsoUrl, handleMicrosoftSsoCallback,
  verifyState,
} from "./oauth.js";
import {
  cookieParser, requireAuth, issueTokens,
  hashPassword, verifyPassword,
  generateRefreshToken, storeRefreshToken, validateRefreshToken,
  revokeRefreshToken, getUserOrgs, createAccessToken,
  clearAuthCookies, setAuthCookies, hashRefreshToken,
} from "./auth.js";
import { resolve as dnsResolve } from "node:dns/promises";

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

// Direct rspamd call — sends raw MIME bytes to rspamd's /checkv2, bypassing
// E1's JSON round-trip that mangles headers. Used when raw_mime is available.
const RSPAMD_URL = process.env.RSPAMD_URL || "http://rspamd:11333";
const RSPAMD_PASSWORD = process.env.RSPAMD_PASSWORD || "";

// Send raw MIME bytes directly to rspamd — no parsing, no field extraction.
// Accepts a Buffer so the original bytes are never touched.
async function callRspamdDirect(rawBuffer) {
  const start = process.hrtime.bigint();
  try {
    const headers = {
      "User-Agent": "etdp-gateway/0.1",
      "IP": "127.0.0.1",
      "Message-Length": rawBuffer.length.toString(),
    };
    if (RSPAMD_PASSWORD) headers["Password"] = RSPAMD_PASSWORD;
    const { statusCode, body } = await request(`${RSPAMD_URL.replace(/\/$/, "")}/checkv2`, {
      method: "POST", headers, body: rawBuffer,
      bodyTimeout: 10_000, headersTimeout: 10_000,
    });
    const text = await body.text();
    if (statusCode >= 400) {
      return { engine: "e1_rspamd", latency_ms: 0, signals: [], error: `rspamd ${statusCode}: ${text.slice(0, 120)}` };
    }
    const resp = JSON.parse(text);
    const signals = rspamdToSignals(resp);
    const latency = Number(process.hrtime.bigint() - start) / 1e6;
    return { engine: "e1_rspamd", latency_ms: latency, signals };
  } catch (err) {
    return { engine: "e1_rspamd", latency_ms: 0, signals: [], error: err.message };
  }
}

// Translate rspamd JSON → Signal[] (same logic as E1 engine).
function rspamdToSignals(rspamdResp) {
  const signals = [];
  const symbols = rspamdResp?.symbols || {};
  for (const name of Object.keys(symbols)) {
    const sym = symbols[name];
    const rawScore = Number(sym?.score || 0);
    const score = rawScore;  // engine scaling now applied in aggregate()
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

// Call SLM directly with raw EML — avoids the large JSON round-trip timeout.
// Sends structured email fields + raw_mime so SLM can see full headers.
async function callSlmDirect(parsedEmail, rawMime, priorSignals) {
  const start = process.hrtime.bigint();
  console.log(`[gateway] callSlmDirect: calling SLM with ${rawMime?.length || 0} bytes of EML`);
  try {
    const payload = {
      ...parsedEmail,
      raw_mime: rawMime,
      prior_signals: priorSignals || [],
    };
    const { statusCode, body } = await request(`${ENGINE_HOSTS.e2_slm}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      bodyTimeout: 60_000,
      headersTimeout: 60_000,
    });
    const text = await body.text();
    const latency = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[gateway] callSlmDirect: SLM responded ${statusCode} in ${latency.toFixed(0)}ms, body=${text.slice(0, 200)}`);
    if (statusCode >= 400) {
      return { engine: "e2_slm", latency_ms: latency, signals: [], error: `SLM ${statusCode}: ${text.slice(0, 200)}` };
    }
    const result = JSON.parse(text);
    console.log(`[gateway] callSlmDirect: parsed ${result.signals?.length || 0} signals`);
    return result;
  } catch (err) {
    console.error(`[gateway] callSlmDirect error: ${err.message}`);
    return { engine: "e2_slm", latency_ms: Number(process.hrtime.bigint() - start) / 1e6, signals: [], error: err.message };
  }
}

async function callEngine(name, email) {
  const url = `${ENGINE_HOSTS[name]}/analyze`;
  try {
    // Only pass raw_mime to the SLM — other engines don't need it and it bloats the payload
    const payload = (name === "e2_slm") ? email : (() => { const { raw_mime, ...rest } = email; return rest; })();
    const timeout = (name === "e2_slm") ? 45_000 : 15_000;
    const { statusCode, body } = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      bodyTimeout: timeout,
      headersTimeout: timeout,
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
        thresholds: { block: 15, quarantine: 8, note: 5 },
        stats_db_weight: 1.0,
        graph_db_weight: 1.0,
        industry_weights: { bec: 1, phishing: 1, malware: 1 },
        engine_weights: { rspamd: 1.0, slm: 1.0, stats_db: 1.0, graph_db: 1.0, url_scanner: 1.0, specialized_ml: 1.0 },
        signal_overrides: {},
      };
    }
    const row = r.rows[0];
    const onboardedMs = new Date(row.onboarded_at).getTime();
    const daysSince = (Date.now() - onboardedMs) / 86400000;
    const statsWeight = Math.min(Math.max(daysSince / 30, 0), 1);
    const graphWeight = Math.min(Math.max(daysSince / 60, 0), 1);  // 60-day ramp per PRD §9.2
    const thresholds = typeof row.thresholds === "string" ? JSON.parse(row.thresholds) : row.thresholds;
    const defaultEngineWeights = { rspamd: 1.0, slm: 1.0, stats_db: 1.0, graph_db: 1.0, url_scanner: 1.0, specialized_ml: 1.0 };
    return {
      known: true,
      industry: row.industry,
      timezone: row.timezone,
      business_hours_start: row.business_hours_start,
      business_hours_end: row.business_hours_end,
      thresholds,
      stats_db_weight: statsWeight,
      graph_db_weight: graphWeight,
      industry_weights: {
        bec: Number(row.bec_weight || 1),
        phishing: Number(row.phishing_weight || 1),
        malware: Number(row.malware_weight || 1),
      },
      engine_weights: { ...defaultEngineWeights, ...thresholds?.engine_weights },
      signal_overrides: thresholds?.signal_overrides || {},
    };
  });
}

export function aggregate(signals, thresholds, industryWeights, engineWeights = {}, signalOverrides = {}) {
  // Apply engine weights, signal overrides, and industry weights.
  let total = 0;
  for (const s of signals) {
    let w = 1;
    if (/phish|dmarc|credential/i.test(s.signal)) w = industryWeights.phishing;
    if (/malware|macro|pe_|dangerous/i.test(s.signal)) w = industryWeights.malware;
    if (/wire|transfer|bec|urgency/i.test(s.signal)) w = industryWeights.bec;
    // Engine scaling (e.g. rspamd default 1.5x)
    w *= engineWeights[s.engine] ?? 1.0;
    // Per-signal override (e.g. mute DATE_IN_PAST by setting to 0)
    w *= signalOverrides[s.signal] ?? 1.0;
    total += (s.score || 0) * w;
  }
  const blockAt = Number(thresholds.block ?? 15);
  const qAt = Number(thresholds.quarantine ?? 8);
  const noteAt = Number(thresholds.note ?? 5);
  if (total >= blockAt) {
    return { total, label: "phishing", verdict: "block",
      reason: `Aggregate score ${total.toFixed(1)} ≥ block threshold ${blockAt}.` };
  }
  if (total >= qAt) {
    return { total, label: "spam", verdict: "quarantine",
      reason: `Aggregate score ${total.toFixed(1)} ≥ quarantine threshold ${qAt}.` };
  }
  if (total >= noteAt) {
    return { total, label: "suspicious", verdict: "note",
      reason: `Aggregate score ${total.toFixed(1)} ≥ note threshold ${noteAt}. Delivered with warning.` };
  }
  return { total, label: "ham", verdict: "allow",
    reason: "No significant threat signals." };
}

// Score the email against the org's incumbent/canary models, choosing
// one deterministically via a hash of message_id so the same email
// consistently hits the same model (stable A/B test).
async function scoreOrgModel(orgId, signals, messageId) {
  const deployments = await cached(`deploys:${orgId}`, 30,
    () => getDeployments(orgId));
  if (!deployments || deployments.length === 0) return null;
  const incumbent = deployments.find((d) => d.role === "incumbent");
  const canary = deployments.find((d) => d.role === "canary");

  // Which model handles this request?
  let chosen = incumbent;
  if (canary) {
    const shard = hashMod100(messageId);
    if (shard < Number(canary.traffic_pct || 0)) chosen = canary;
  }
  if (!chosen) return null;

  const features = signalsToFeatures(signals);
  const proba = predictProba(chosen.weights, chosen.intercept, features);
  return {
    model_version: chosen.model_version,
    model_role: chosen.role,
    probability: Number(proba.toFixed(4)),
    features_on: features.reduce((a, v) => a + v, 0),
  };
}

function hashMod100(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100;
}

async function persistVerdict(email, verdict) {
  const bodyPreview = (email.body_text || "").slice(0, 500) || null;
  await safeOrgQuery(email.org_id,
    `INSERT INTO verdicts
       (org_id, message_id, sender, recipient, subject, body_preview,
        verdict, label, confidence,
        threat_score, reason, signals, pipeline, fast_path_ms, deep_path_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verdict=VALUES(verdict), label=VALUES(label), confidence=VALUES(confidence),
       threat_score=VALUES(threat_score), reason=VALUES(reason),
       signals=VALUES(signals), pipeline=VALUES(pipeline),
       fast_path_ms=VALUES(fast_path_ms), deep_path_ms=VALUES(deep_path_ms),
       subject=VALUES(subject), body_preview=VALUES(body_preview)`,
    [
      email.org_id, email.message_id, email.sender,
      (email.recipients && email.recipients[0]) || "",
      email.subject || null, bodyPreview,
      verdict.verdict, verdict.label, verdict.confidence,
      verdict.threat_score, verdict.reason,
      JSON.stringify(verdict.signals_fired),
      JSON.stringify(verdict.pipeline),
      verdict.pipeline.fast_path_ms ?? null,
      verdict.pipeline.deep_path_ms ?? null,
    ],
  );
}

// ── Domain → Org mapping with in-memory cache (60s TTL) ─────────────
let domainCache = new Map();   // domain → org_id
let domainCacheAt = 0;
const DOMAIN_CACHE_TTL = 60_000;

async function refreshDomainCache() {
  if (Date.now() - domainCacheAt < DOMAIN_CACHE_TTL) return;
  try {
    const r = await safeQuery(
      `SELECT domain, org_id FROM org_domains WHERE verified = 1`
    );
    if (r.ok) {
      const m = new Map();
      for (const row of r.rows) m.set(row.domain, row.org_id);
      domainCache = m;
      domainCacheAt = Date.now();
    }
  } catch {}
}

// Map recipient email domain to org_id.
// Checks org_domains first (verified), falls back to raw domain for backward compat.
async function deriveOrgId(recipientAddress) {
  const domain = (recipientAddress.split("@")[1] || "unknown").toLowerCase();
  await refreshDomainCache();
  return domainCache.get(domain) || domain;
}

// Pipeline variant for SMTP: returns verdict object instead of writing to res.json().
async function runPipelineSmtp(email, rspamdResult, slmResult) {
  const fakeRes = { json(v) { fakeRes._verdict = v; } };
  await runPipelineWithPre(email, rspamdResult, fakeRes, slmResult);
  return fakeRes._verdict;
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.raw({ type: "message/rfc822", limit: "25mb" }));
app.use(cookieParser);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

// ── Login Page ──────────────────────────────────────────────────────
app.get("/login", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderLoginPage());
});

// ── Auth Routes (public) ────────────────────────────────────────────

app.post("/auth/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: "email, password, name required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  // Check if email already exists
  const existing = await safeQuery(`SELECT id FROM users WHERE email = ?`, [email.toLowerCase()]);
  if (existing.ok && existing.rows.length > 0) {
    return res.status(409).json({ error: "email already registered" });
  }
  const hash = await hashPassword(password);
  const r = await safeQuery(
    `INSERT INTO users (email, password_hash, name, email_verified) VALUES (?, ?, ?, 1)`,
    [email.toLowerCase(), hash, name],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  const user = { id: r.rows.insertId, email: email.toLowerCase(), name };
  await issueTokens(res, user);
  res.json({ status: "ok", user: { id: user.id, email: user.email, name: user.name } });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }
  const r = await safeQuery(
    `SELECT id, email, name, password_hash FROM users WHERE email = ? LIMIT 1`,
    [email.toLowerCase()],
  );
  if (!r.ok || r.rows.length === 0) {
    return res.status(401).json({ error: "invalid email or password" });
  }
  const user = r.rows[0];
  if (!user.password_hash) {
    return res.status(401).json({ error: "this account uses SSO login" });
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "invalid email or password" });
  }
  await issueTokens(res, user);
  res.json({ status: "ok", user: { id: user.id, email: user.email, name: user.name } });
});

app.post("/auth/refresh", async (req, res) => {
  const rawToken = req.cookies?.refresh_token;
  if (!rawToken) return res.status(401).json({ error: "no refresh token" });
  const tokenData = await validateRefreshToken(rawToken);
  if (!tokenData) return res.status(401).json({ error: "invalid or expired refresh token" });
  // Revoke old, issue new (rotation)
  await revokeRefreshToken(rawToken);
  const user = { id: tokenData.userId, email: tokenData.email, name: tokenData.name };
  await issueTokens(res, user);
  res.json({ status: "ok" });
});

app.post("/auth/logout", async (req, res) => {
  const rawToken = req.cookies?.refresh_token;
  if (rawToken) await revokeRefreshToken(rawToken);
  clearAuthCookies(res);
  res.json({ status: "ok" });
});

// ── SSO Login Routes ────────────────────────────────────────────────

async function findOrCreateSsoUser(provider, profile) {
  // 1. Look up by SSO subject
  let r = await safeQuery(
    `SELECT id, email, name FROM users WHERE sso_provider = ? AND sso_subject = ? LIMIT 1`,
    [provider, profile.sub],
  );
  if (r.ok && r.rows.length > 0) return r.rows[0];
  // 2. Look up by email — link SSO
  r = await safeQuery(`SELECT id, email, name FROM users WHERE email = ? LIMIT 1`, [profile.email.toLowerCase()]);
  if (r.ok && r.rows.length > 0) {
    await safeQuery(
      `UPDATE users SET sso_provider = ?, sso_subject = ?, email_verified = 1 WHERE id = ?`,
      [provider, profile.sub, r.rows[0].id],
    );
    return r.rows[0];
  }
  // 3. Create new user
  const ins = await safeQuery(
    `INSERT INTO users (email, name, sso_provider, sso_subject, email_verified) VALUES (?, ?, ?, ?, 1)`,
    [profile.email.toLowerCase(), profile.name, provider, profile.sub],
  );
  if (!ins.ok) throw new Error(ins.error);
  return { id: ins.rows.insertId, email: profile.email.toLowerCase(), name: profile.name };
}

app.get("/auth/sso/google", (_req, res) => {
  res.redirect(buildGoogleSsoUrl());
});

app.get("/auth/sso/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const st = verifyState(state);
  if (!st || st.provider !== "google_sso") {
    return res.status(400).send("Invalid state");
  }
  try {
    const profile = await handleGoogleSsoCallback(code);
    const user = await findOrCreateSsoUser("google", profile);
    await issueTokens(res, user);
    res.redirect("/admin/dashboard");
  } catch (err) {
    console.error("[auth] Google SSO error:", err.message);
    res.redirect("/login?error=sso_failed");
  }
});

app.get("/auth/sso/microsoft", (_req, res) => {
  res.redirect(buildMicrosoftSsoUrl());
});

app.get("/auth/sso/microsoft/callback", async (req, res) => {
  const { code, state } = req.query;
  const st = verifyState(state);
  if (!st || st.provider !== "microsoft_sso") {
    return res.status(400).send("Invalid state");
  }
  try {
    const profile = await handleMicrosoftSsoCallback(code);
    const user = await findOrCreateSsoUser("microsoft", profile);
    await issueTokens(res, user);
    res.redirect("/admin/dashboard");
  } catch (err) {
    console.error("[auth] Microsoft SSO error:", err.message);
    res.redirect("/login?error=sso_failed");
  }
});

// ── Auth Middleware — protect /v1 and /admin ────────────────────────
app.use("/v1", requireAuth);
app.use("/admin", requireAuth);

// Parse References/In-Reply-To headers to find parent message IDs.
function parseReferences(headers) {
  const refs = [];
  const inReplyTo = headers?.["In-Reply-To"] || headers?.in_reply_to || "";
  const references = headers?.References || headers?.references || "";
  const combined = `${inReplyTo} ${references}`;
  const matches = combined.match(/<[^>]+>/g) || [];
  for (const m of matches) {
    const id = m.slice(1, -1); // strip < >
    if (id && !refs.includes(id)) refs.push(id);
  }
  return refs.slice(0, 20); // cap for safety
}

// Assemble thread context from email_metadata for conversation-aware signals.
async function assembleThread(email) {
  const refs = parseReferences(email.headers);
  if (refs.length === 0) return [];
  try {
    const r = await safeOrgQuery(email.org_id,
      `SELECT sender, sender_domain, body_length, link_count, \`timestamp\`, message_id,
              subject_length, has_attachment
       FROM email_metadata
       WHERE org_id = ? AND message_id IN (?)
       ORDER BY \`timestamp\` ASC
       LIMIT 10`,
      [email.org_id, refs],
    );
    if (!r.ok || r.rows.length === 0) return [];
    return r.rows.map((row) => ({
      sender: row.sender,
      sender_domain: row.sender_domain,
      body_length: row.body_length,
      link_count: row.link_count,
      has_attachment: row.has_attachment,
      ts: row.timestamp,
      message_id: row.message_id,
    }));
  } catch { return []; }
}

// ── Shared analysis pipeline (used by both JSON and EML endpoints) ────
// runPipelineWithPre: rspamd already ran, start from its result.
// runPipeline: full pipeline (calls E1 rspamd via JSON fanout).
async function runPipelineWithPre(email, rspamdResult, res, slmResult = null) {
  return _runPipeline(email, [rspamdResult], res, slmResult);
}

async function runPipeline(email, res) {
  return _runPipeline(email, null, res);
}

async function _runPipeline(email, preResponses, res, slmResult = null) {
  const orgCtx = await loadOrgContext(email.org_id);
  await provisionOrg(email.org_id).catch(() => {});
  const thread = await assembleThread(email);
  const enrichedEmail = { ...email, org_context: orgCtx, thread };

  const t0 = process.hrtime.bigint();

  // Stage 1: rspamd. Already done if preResponses provided, otherwise fanout to E1.
  if (!preResponses) {
    preResponses = await fanout(FAST_PRE, enrichedEmail);
  }
  const preSignals = preResponses.flatMap((r) => r.signals || []);

  // Stage 2: SLM sees rspamd signals via prior_signals; Stats/Graph run in parallel.
  // If SLM was already called directly (EML path), skip it from fanout.
  const stage2Payload = { ...enrichedEmail, prior_signals: preSignals };
  const stage2Engines = slmResult ? FAST_MAIN.filter((e) => e !== "e2_slm") : FAST_MAIN;
  const mainResponses = await fanout(stage2Engines, stage2Payload);
  if (slmResult) mainResponses.push(slmResult);
  for (const r of mainResponses) {
    console.log(`[gateway] stage2 ${r.engine}: ${r.signals?.length || 0} signals ${r.error ? "ERR:" + r.error : ""}`);
  }
  const fastSignals = [...preSignals, ...mainResponses.flatMap((r) => r.signals || [])];

  const fastAgg = aggregate(fastSignals, orgCtx.thresholds, orgCtx.industry_weights, orgCtx.engine_weights, orgCtx.signal_overrides);
  const fastMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const fastConfidence = Math.min(fastAgg.total / 15, 1);
  let deepSignals = [];
  let deepMs = 0;
  const enginesInvoked = [...FAST_PRE, ...FAST_MAIN];
  let asyncDeepPath = false;

  // Always run deep path engines on every email for full signal coverage
  {
    const t1 = process.hrtime.bigint();
    const deepPayload = { ...enrichedEmail, prior_signals: fastSignals };
    const deepResponses = await fanout(DEEP_PATH, deepPayload);
    for (const r of deepResponses) {
      console.log(`[gateway] deep ${r.engine}: ${r.signals?.length || 0} signals ${r.error ? "ERR:" + r.error : ""}`);
    }
    deepSignals = deepResponses.flatMap((r) => r.signals || []);
    deepMs = Number(process.hrtime.bigint() - t1) / 1e6;
    enginesInvoked.push(...DEEP_PATH);
  }

  const allSignals = [...fastSignals, ...deepSignals];
  const finalAgg = asyncDeepPath
    ? { total: fastAgg.total, label: "spam", verdict: "quarantine",
        reason: `Awaiting deep path (fast score ${fastAgg.total.toFixed(1)}).` }
    : aggregate(allSignals, orgCtx.thresholds, orgCtx.industry_weights, orgCtx.engine_weights, orgCtx.signal_overrides);

  const modelResult = await scoreOrgModel(email.org_id, allSignals, email.message_id);

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
      async_deep_path: asyncDeepPath,
    },
    metadata: {
      org_id: email.org_id, message_id: email.message_id,
      model_version: "phase2-0.1",
      org_known: orgCtx.known,
      industry: orgCtx.industry,
      org_model: modelResult,
    },
  };

  await persistVerdict(email, verdict);
  res.json(verdict);
}

app.post("/v1/analyze", async (req, res) => {
  let body = req.body;

  // If raw_mime is provided but core fields are missing, auto-parse from raw_mime
  if (body.raw_mime && (!body.sender || !body.subject)) {
    try {
      const parsed = await parseEml(body.raw_mime);
      body = { ...parsed, ...filterDefined(body) };
    } catch (err) {
      return res.status(400).json({ error: `failed to parse raw_mime: ${err.message}` });
    }
  }

  let email;
  try { email = Email.parse(body); }
  catch (err) { return res.status(400).json({ error: `invalid email payload: ${err.message}` }); }

  await runPipeline(email, res);
});

// EML-native endpoint: accepts raw RFC 2822 MIME body.
// Raw bytes go directly to rspamd (stage 1) without any parsing.
// Parsing only happens for the other engines that need structured fields.
app.post("/v1/analyze/eml", async (req, res) => {
  const orgId = req.headers["x-org-id"];
  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header is required" });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  if (!rawBody || rawBody.length === 0) {
    return res.status(400).json({ error: "empty EML body" });
  }

  // Stage 1: fire raw bytes at rspamd + parse EML in parallel.
  const rawMimeStr = rawBody.toString("utf-8");
  console.log(`[gateway] EML endpoint: rawBody=${rawBody.length} bytes, type=${typeof req.body}, isBuffer=${Buffer.isBuffer(req.body)}`);
  const [rspamdResult, parseResult] = await Promise.all([
    callRspamdDirect(rawBody),
    parseEml(rawMimeStr).catch((err) => ({ error: err.message })),
  ]);
  console.log(`[gateway] EML parsed: sender=${parseResult.sender?.slice(0,40)}, subj=${parseResult.subject?.slice(0,40)}, body_len=${parseResult.body_text?.length}`);

  if (parseResult.error) {
    return res.status(400).json({ error: `failed to parse EML: ${parseResult.error}` });
  }

  let email;
  try {
    email = Email.parse({ ...parseResult, org_id: orgId });
  } catch (err) {
    return res.status(400).json({ error: `invalid parsed email: ${err.message}` });
  }

  // Attach raw EML so SLM can analyze full headers
  email.raw_mime = rawMimeStr;

  // Call SLM directly with raw EML + rspamd signals (parallel with stage 2 fanout)
  const rspamdSignals = rspamdResult.signals || [];
  const slmResult = await callSlmDirect(email, rawMimeStr, rspamdSignals);

  await runPipelineWithPre(email, rspamdResult, res, slmResult);
});

// Helper: filter out undefined/null values so explicit JSON fields override parsed ones
function filterDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

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
  const r = await safeOrgQuery(org_id,
    `INSERT INTO feedback_labels (org_id, message_id, action, source, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [org_id, message_id, action, source, notes],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ status: "ok", id: r.rows.insertId });
});

app.get("/v1/verdicts", async (req, res) => {
  const { org_id, label, verdict, since, limit = "50" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const clauses = ["org_id = ?"];
  const params = [org_id];
  if (label) { clauses.push("label = ?"); params.push(label); }
  if (verdict) { clauses.push("verdict = ?"); params.push(verdict); }
  if (since) { clauses.push("created_at >= ?"); params.push(new Date(since)); }
  const limitN = Math.min(Number(limit) || 50, 500);
  const r = await safeOrgQuery(org_id,
    `SELECT id, org_id, message_id, sender, recipient, subject, body_preview,
            verdict, label, confidence,
            threat_score, reason, signals, fast_path_ms, deep_path_ms, created_at
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
  const r = await safeOrgQuery(org_id,
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
    thresholds = { block: 15, quarantine: 8, note: 5 },
    domains = [], integration_type = "none",
  } = req.body || {};
  if (!org_id || !name) return res.status(400).json({ error: "org_id, name required" });
  const r = await safeQuery(
    `INSERT INTO orgs (org_id, name, industry, timezone,
                       business_hours_start, business_hours_end, thresholds, integration_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), industry=VALUES(industry),
       timezone=VALUES(timezone), business_hours_start=VALUES(business_hours_start),
       business_hours_end=VALUES(business_hours_end), thresholds=VALUES(thresholds),
       integration_type=VALUES(integration_type)`,
    [org_id, name, industry, timezone, business_hours_start, business_hours_end,
     JSON.stringify(thresholds), integration_type],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  const prov = await provisionOrg(org_id);
  if (!prov.ok) return res.status(500).json({ error: prov.error });

  // Add domains if provided
  const { randomBytes } = await import("node:crypto");
  for (const d of domains) {
    const token = randomBytes(16).toString("hex");
    await safeQuery(
      `INSERT INTO org_domains (org_id, domain, verify_token, verified)
       VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE org_id = VALUES(org_id), verified = 1`,
      [org_id, d.toLowerCase(), token],
    );
  }
  // Invalidate domain cache
  domainCacheAt = 0;

  // Link creating user as admin of this org
  if (req.user?.sub) {
    await safeQuery(
      `INSERT INTO user_orgs (user_id, org_id, role) VALUES (?, ?, 'admin')
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [req.user.sub, org_id],
    );
  }

  res.json({ status: "ok", org_id, db_name: prov.db_name, provisioned: prov.provisioned });
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

// ── Signal config (per-org engine weights + signal overrides) ────────────

app.get("/v1/orgs/:id/signal-config", async (req, res) => {
  const orgId = req.params.id;
  const orgRes = await safeQuery(`SELECT thresholds FROM orgs WHERE org_id = ?`, [orgId]);
  if (!orgRes.ok) return res.status(500).json({ error: orgRes.error });
  if (orgRes.rows.length === 0) return res.status(404).json({ error: "org not found" });

  const thresholds = typeof orgRes.rows[0].thresholds === "string"
    ? JSON.parse(orgRes.rows[0].thresholds) : (orgRes.rows[0].thresholds || {});

  const defaultEngineWeights = { rspamd: 1.0, slm: 1.0, stats_db: 1.0, graph_db: 1.0, url_scanner: 1.0, specialized_ml: 1.0 };
  const engineWeights = { ...defaultEngineWeights, ...thresholds.engine_weights };
  const signalOverrides = thresholds.signal_overrides || {};

  // Gather known signals from recent verdicts for this org
  const sigRes = await safeOrgQuery(orgId,
    `SELECT signals FROM verdicts WHERE org_id = ? ORDER BY created_at DESC LIMIT 200`,
    [orgId],
  );
  const signalMap = {};  // signal_name → { engine, count, total_score }
  if (sigRes.ok) {
    for (const row of sigRes.rows) {
      const sigs = typeof row.signals === "string" ? JSON.parse(row.signals) : (row.signals || []);
      for (const s of sigs) {
        if (!signalMap[s.signal]) signalMap[s.signal] = { engine: s.engine, count: 0, total_score: 0 };
        signalMap[s.signal].count++;
        signalMap[s.signal].total_score += Math.abs(s.score || 0);
      }
    }
  }
  const knownSignals = Object.entries(signalMap).map(([name, info]) => ({
    signal: name,
    engine: info.engine,
    fire_count: info.count,
    avg_score: Number((info.total_score / info.count).toFixed(2)),
    weight: signalOverrides[name] ?? 1.0,
  })).sort((a, b) => b.fire_count - a.fire_count);

  res.json({ engine_weights: engineWeights, signal_overrides: signalOverrides, known_signals: knownSignals });
});

// ── Model registry (PRD §10.1 admin APIs) ──────────────────────────────

app.get("/v1/orgs/:id/models", async (req, res) => {
  const r = await safeQuery(
    `SELECT version, model_kind, val_accuracy, val_precision, val_recall,
            val_fp_rate, trained_at, trained_on, status, parent_version
     FROM org_models WHERE org_id=? ORDER BY trained_at DESC LIMIT 50`,
    [req.params.id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, models: r.rows });
});

app.get("/v1/orgs/:id/deployments", async (req, res) => {
  const deployments = await getDeployments(req.params.id);
  res.json(deployments.map((d) => ({
    role: d.role, model_version: d.model_version, traffic_pct: d.traffic_pct,
    val_accuracy: d.val_accuracy ?? null,
  })));
});

app.get("/v1/orgs/:id/training_jobs", async (req, res) => {
  const r = await safeQuery(
    `SELECT id, started_at, finished_at, status, labels_used,
            resulting_version, notes
     FROM training_jobs WHERE org_id=? ORDER BY started_at DESC LIMIT 50`,
    [req.params.id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ count: r.rows.length, jobs: r.rows });
});

// ── Org listing (for dashboard dropdown) ──────────────────────────────

app.get("/v1/orgs", async (req, res) => {
  const userOrgIds = (req.user.orgs || []).map((o) => o.org_id);
  if (userOrgIds.length === 0) return res.json([]);
  const r = await safeQuery(
    `SELECT org_id, name, industry FROM orgs WHERE org_id IN (?) ORDER BY name`,
    [userOrgIds],
  );
  res.json(r.ok ? r.rows : []);
});

// ── Full verdict detail (signals + pipeline + feedback) ───────────────

app.get("/v1/verdicts/:org_id/:message_id", async (req, res) => {
  const { org_id, message_id } = req.params;
  const vr = await safeOrgQuery(org_id,
    `SELECT id, org_id, message_id, sender, recipient, subject, body_preview,
            verdict, label, confidence,
            threat_score, reason, signals, pipeline, fast_path_ms, deep_path_ms, created_at
     FROM verdicts WHERE org_id = ? AND message_id = ? LIMIT 1`,
    [org_id, message_id],
  );
  if (!vr.ok) return res.status(500).json({ error: vr.error });
  if (vr.rows.length === 0) return res.status(404).json({ error: "verdict not found" });

  const row = vr.rows[0];
  row.signals = typeof row.signals === "string" ? JSON.parse(row.signals) : row.signals;
  row.pipeline = typeof row.pipeline === "string" ? JSON.parse(row.pipeline) : row.pipeline;

  const fr = await safeOrgQuery(org_id,
    `SELECT action, source, notes, created_at FROM feedback_labels
     WHERE org_id = ? AND message_id = ? ORDER BY created_at DESC`,
    [org_id, message_id],
  );

  res.json({ verdict: row, feedback: fr.ok ? fr.rows : [] });
});

// ── Dashboard Data APIs ──────────────────────────────────────────────

app.get("/v1/dashboard/timeline", async (req, res) => {
  const { org_id, days = "7" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const daysN = Math.min(Number(days) || 7, 90);
  const r = await safeOrgQuery(org_id,
    `SELECT DATE(created_at) AS day, COUNT(*) AS value
     FROM verdicts WHERE org_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(created_at) ORDER BY day ASC`,
    [org_id, daysN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, days: daysN, points: r.rows });
});

app.get("/v1/dashboard/top-senders", async (req, res) => {
  const { org_id, limit = "20" } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const limitN = Math.min(Number(limit) || 20, 100);
  const r = await safeOrgQuery(org_id,
    `SELECT sender,
            SUBSTRING_INDEX(sender, '@', -1) AS sender_domain,
            COUNT(*) AS count,
            AVG(threat_score) AS avg_score
     FROM verdicts WHERE org_id = ? AND verdict IN ('block','quarantine')
     GROUP BY sender ORDER BY avg_score DESC LIMIT ?`,
    [org_id, limitN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, senders: r.rows });
});

app.get("/v1/dashboard/users", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT recipient,
            COUNT(*) AS total,
            SUM(verdict = 'block') AS blocked,
            SUM(verdict = 'quarantine') AS quarantined,
            SUM(verdict = 'allow') AS allowed,
            AVG(threat_score) AS avg_score
     FROM verdicts WHERE org_id = ?
     GROUP BY recipient ORDER BY blocked DESC, quarantined DESC LIMIT 50`,
    [org_id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id, users: r.rows });
});

app.get("/v1/dashboard/vips", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT gdn.address, gdn.display_name,
            COALESCE(gt.trust_score, 0.5) AS trust_score,
            COALESCE(gn.sent_count, 0) AS sent_count,
            COALESCE(gn.recv_count, 0) AS recv_count,
            (SELECT COUNT(*) FROM verdicts v WHERE v.org_id = ? AND v.recipient = gdn.address AND v.verdict IN ('block','quarantine')) AS threat_count
     FROM graph_display_names gdn
     LEFT JOIN graph_trust gt ON gt.org_id = gdn.org_id AND gt.address = gdn.address
     LEFT JOIN graph_nodes gn ON gn.org_id = gdn.org_id AND gn.address = gdn.address
     WHERE gdn.org_id = ?
     ORDER BY threat_count DESC, trust_score ASC LIMIT 20`,
    [org_id, org_id],
  );
  // If graph tables don't exist yet, return empty
  if (!r.ok) return res.json({ org_id, vips: [] });
  res.json({ org_id, vips: r.rows });
});

app.get("/v1/dashboard/domains", async (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  const r = await safeOrgQuery(org_id,
    `SELECT domain, first_seen, total_emails_from, is_freemail, avg_threat_score
     FROM domain_first_seen WHERE org_id = ?
     ORDER BY avg_threat_score DESC, total_emails_from DESC LIMIT 100`,
    [org_id],
  );
  if (!r.ok) return res.json({ org_id, domains: [] });
  res.json({ org_id, domains: r.rows });
});

app.get("/v1/dashboard/urls", async (req, res) => {
  const { limit = "100" } = req.query;
  const limitN = Math.min(Number(limit) || 100, 500);
  const r = await safeQuery(
    `SELECT url, final_url, redirect_hops, final_status, risk_score, scanned_at
     FROM url_scan_cache ORDER BY scanned_at DESC LIMIT ?`,
    [limitN],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ urls: r.rows });
});

// ── Domain Management ────────────────────────────────────────────────

app.get("/v1/orgs/:id/domains", async (req, res) => {
  const r = await safeQuery(
    `SELECT domain, verified, verify_token, created_at FROM org_domains WHERE org_id = ? ORDER BY created_at`,
    [req.params.id],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ org_id: req.params.id, domains: r.rows });
});

app.post("/v1/orgs/:id/domains", async (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain required" });
  const d = domain.toLowerCase();
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(16).toString("hex");
  const r = await safeQuery(
    `INSERT INTO org_domains (org_id, domain, verify_token, verified) VALUES (?, ?, ?, 1)`,
    [req.params.id, d, token],
  );
  if (!r.ok) {
    if (r.error?.includes("Duplicate")) return res.status(409).json({ error: "domain already registered" });
    return res.status(500).json({ error: r.error });
  }
  domainCacheAt = 0;
  res.json({ status: "ok", domain: d, verify_token: token });
});

app.delete("/v1/orgs/:id/domains/:domain", async (req, res) => {
  const r = await safeQuery(
    `DELETE FROM org_domains WHERE org_id = ? AND domain = ?`,
    [req.params.id, req.params.domain.toLowerCase()],
  );
  if (!r.ok) return res.status(500).json({ error: r.error });
  if (r.rows.affectedRows === 0) return res.status(404).json({ error: "domain not found" });
  domainCacheAt = 0;
  res.json({ status: "ok" });
});

app.post("/v1/orgs/:id/domains/:domain/verify", async (req, res) => {
  const domain = req.params.domain.toLowerCase();
  const r = await safeQuery(
    `SELECT verify_token FROM org_domains WHERE org_id = ? AND domain = ?`,
    [req.params.id, domain],
  );
  if (!r.ok || r.rows.length === 0) return res.status(404).json({ error: "domain not found" });
  const expectedToken = r.rows[0].verify_token;

  // DNS TXT lookup for _etdp-verify.<domain>
  let verified = false;
  try {
    const records = await dnsResolve(`_etdp-verify.${domain}`, "TXT");
    for (const rec of records) {
      const txt = Array.isArray(rec) ? rec.join("") : rec;
      if (txt === expectedToken) { verified = true; break; }
    }
  } catch {}

  if (verified) {
    await safeQuery(
      `UPDATE org_domains SET verified = 1 WHERE org_id = ? AND domain = ?`,
      [req.params.id, domain],
    );
    domainCacheAt = 0;
  }

  res.json({ domain, verified, verify_token: expectedToken });
});

// ── OAuth Routes ─────────────────────────────────────────────────────

app.get("/v1/oauth/google/start", (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  res.redirect(buildGoogleAuthUrl(org_id));
});

app.get("/v1/oauth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const payload = verifyState(state);
  if (!payload || payload.provider !== "google") return res.status(400).send("Invalid state");
  const orgId = payload.org_id;
  try {
    const tokens = await handleGoogleCallback(code);
    const expires = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await safeQuery(
      `INSERT INTO oauth_connectors (org_id, provider, access_token, refresh_token, token_expires, scopes, status)
       VALUES (?, 'google', ?, ?, ?, ?, 'connected')
       ON DUPLICATE KEY UPDATE access_token=VALUES(access_token), refresh_token=COALESCE(VALUES(refresh_token), refresh_token),
         token_expires=VALUES(token_expires), scopes=VALUES(scopes), status='connected'`,
      [orgId, tokens.access_token, tokens.refresh_token, expires, tokens.scope],
    );
    await safeQuery(`UPDATE orgs SET integration_type = 'oauth_google' WHERE org_id = ?`, [orgId]);
    res.redirect(`/signup#step=4&org_id=${encodeURIComponent(orgId)}&oauth=success`);
  } catch (err) {
    console.error(`[oauth] Google callback error: ${err.message}`);
    res.redirect(`/signup#step=4&org_id=${encodeURIComponent(orgId)}&oauth=error`);
  }
});

app.get("/v1/oauth/microsoft/start", (req, res) => {
  const { org_id } = req.query;
  if (!org_id) return res.status(400).json({ error: "org_id required" });
  res.redirect(buildMicrosoftAuthUrl(org_id));
});

app.get("/v1/oauth/microsoft/callback", async (req, res) => {
  const { code, state } = req.query;
  const payload = verifyState(state);
  if (!payload || payload.provider !== "microsoft") return res.status(400).send("Invalid state");
  const orgId = payload.org_id;
  try {
    const tokens = await handleMicrosoftCallback(code);
    const expires = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await safeQuery(
      `INSERT INTO oauth_connectors (org_id, provider, access_token, refresh_token, token_expires, scopes, status)
       VALUES (?, 'microsoft', ?, ?, ?, ?, 'connected')
       ON DUPLICATE KEY UPDATE access_token=VALUES(access_token), refresh_token=COALESCE(VALUES(refresh_token), refresh_token),
         token_expires=VALUES(token_expires), scopes=VALUES(scopes), status='connected'`,
      [orgId, tokens.access_token, tokens.refresh_token, expires, tokens.scope],
    );
    await safeQuery(`UPDATE orgs SET integration_type = 'oauth_microsoft' WHERE org_id = ?`, [orgId]);
    res.redirect(`/signup#step=4&org_id=${encodeURIComponent(orgId)}&oauth=success`);
  } catch (err) {
    console.error(`[oauth] Microsoft callback error: ${err.message}`);
    res.redirect(`/signup#step=4&org_id=${encodeURIComponent(orgId)}&oauth=error`);
  }
});

app.get("/v1/orgs/:id/integration-status", async (req, res) => {
  const orgId = req.params.id;
  const orgRes = await safeQuery(`SELECT integration_type FROM orgs WHERE org_id = ?`, [orgId]);
  if (!orgRes.ok || orgRes.rows.length === 0) return res.status(404).json({ error: "org not found" });
  const intType = orgRes.rows[0].integration_type || "none";

  let status = "not_configured";
  if (intType.startsWith("oauth_")) {
    const provider = intType.replace("oauth_", "");
    const cr = await safeQuery(
      `SELECT status, token_expires FROM oauth_connectors WHERE org_id = ? AND provider = ?`,
      [orgId, provider],
    );
    if (cr.ok && cr.rows.length > 0) {
      status = cr.rows[0].status;
    }
  } else if (intType === "smtp_relay") {
    status = "configured";
  }

  res.json({ org_id: orgId, integration_type: intType, status });
});

// ── Signup Page ──────────────────────────────────────────────────────

app.get("/signup", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderSignupPage());
});

// ── SOC Analyst Dashboard ─────────────────────────────────────────────

app.get("/admin/dashboard", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderDashboardPage());
});

// ── Service Status Dashboard (admin) ────────────────────────────────────

const ALL_SERVICES = Object.fromEntries([
  ...Object.entries(ENGINE_HOSTS),
  ["deep_path_worker", process.env.DEEP_PATH_WORKER_URL || "http://deep_path_worker:80"],
]);

const VALID_SERVICE_NAMES = new Set(Object.keys(ALL_SERVICES));

app.get("/admin/status", async (_req, res) => {
  const results = await Promise.all(
    Object.entries(ALL_SERVICES).map(async ([name, baseUrl]) => {
      const start = Date.now();
      try {
        const { statusCode, body } = await request(`${baseUrl}/health`, {
          method: "GET",
          headersTimeout: 3000,
          bodyTimeout: 3000,
        });
        const text = await body.text();
        const elapsed = Date.now() - start;
        if (statusCode >= 400) {
          return { name, status: "down", latency_ms: elapsed, error: `HTTP ${statusCode}` };
        }
        return { name, status: "ok", latency_ms: elapsed };
      } catch (err) {
        return { name, status: "down", latency_ms: Date.now() - start, error: err.message };
      }
    }),
  );
  res.json(results);
});

app.post("/admin/restart/:service", async (req, res) => {
  const { service } = req.params;
  if (!VALID_SERVICE_NAMES.has(service)) {
    return res.status(400).json({ error: `unknown service: ${service}` });
  }
  const baseUrl = ALL_SERVICES[service];
  try {
    const { statusCode, body } = await request(`${baseUrl}/shutdown`, {
      method: "POST",
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    await body.text();
    if (statusCode >= 400) {
      return res.status(502).json({ error: `shutdown returned HTTP ${statusCode}` });
    }
    res.json({ status: "restarting", service });
  } catch (err) {
    res.status(502).json({ error: `failed to reach ${service}: ${err.message}` });
  }
});

app.get("/admin/ui", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(renderStatusPage());
});

// ── Embedded SMTP Server (Google Workspace inbound) ─────────────────────
const smtpServer = new SMTPServer({
  name: "etdp-gateway",
  banner: "ETDP Email Security Gateway",
  size: 25 * 1024 * 1024,
  disabledCommands: ["AUTH"],
  secure: false,
  needsUpgrade: false,
  ...(process.env.SMTP_TLS_KEY ? {
    key: fs.readFileSync(process.env.SMTP_TLS_KEY),
    cert: fs.readFileSync(process.env.SMTP_TLS_CERT),
  } : {}),

  onRcptTo(address, session, callback) {
    callback();
  },

  onData(stream, session, callback) {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", async () => {
      const rawBuffer = Buffer.concat(chunks);
      try {
        const recipient = session.envelope.rcptTo[0]?.address || "";
        const orgId = await deriveOrgId(recipient);

        const rawMimeStr = rawBuffer.toString("utf-8");
        const [rspamdResult, parseResult] = await Promise.all([
          callRspamdDirect(rawBuffer),
          parseEml(rawMimeStr).catch((err) => ({ error: err.message })),
        ]);

        if (parseResult.error) {
          console.error(`[smtp] EML parse error: ${parseResult.error}`);
          callback(new Error("Failed to parse message"));
          return;
        }

        let email;
        try {
          email = Email.parse({ ...parseResult, org_id: orgId });
        } catch (err) {
          console.error(`[smtp] Email validation error: ${err.message}`);
          callback(new Error("Invalid email"));
          return;
        }

        email.raw_mime = rawMimeStr;
        const rspamdSignals = rspamdResult.signals || [];
        const slmResult = await callSlmDirect(email, rawMimeStr, rspamdSignals);

        await runPipelineSmtp(email, rspamdResult, slmResult);

        // Always accept — never leak verdict/score via SMTP response.
        // Verdicts are stored internally; actions (quarantine/block) happen downstream.
        callback(null, "Message accepted");
      } catch (err) {
        console.error(`[smtp] Pipeline error: ${err.message}`);
        callback(null, "Message accepted"); // fail-open: don't lose mail
      }
    });
  },
});

if (process.env.ETDP_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT || 8000);
  app.listen(port, () => console.log(`[gateway] HTTP listening on :${port}`));

  const smtpPort = Number(process.env.SMTP_PORT || 2525);
  smtpServer.listen(smtpPort, () => console.log(`[gateway] SMTP listening on :${smtpPort}`));
}

export { app, smtpServer };
