// oauth.js — Google & Microsoft OAuth helpers for ETDP gateway
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── env ────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI  || "";

const MS_CLIENT_ID         = process.env.MICROSOFT_CLIENT_ID     || "";
const MS_CLIENT_SECRET     = process.env.MICROSOFT_CLIENT_SECRET || "";
const MS_REDIRECT_URI      = process.env.MICROSOFT_REDIRECT_URI  || "";

const STATE_SECRET         = process.env.OAUTH_STATE_SECRET || randomBytes(32).toString("hex");

// ── HMAC state (CSRF protection) ───────────────────────────
export function signState(payload) {
  const json = JSON.stringify(payload);
  const b64  = Buffer.from(json).toString("base64url");
  const sig  = createHmac("sha256", STATE_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyState(state) {
  const [b64, sig] = (state || "").split(".");
  if (!b64 || !sig) return null;
  const expected = createHmac("sha256", STATE_SECRET).update(b64).digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch {
    return null;
  }
}

// ── Google OAuth ───────────────────────────────────────────
const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES    = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify";

export function buildGoogleAuthUrl(orgId) {
  const state = signState({ provider: "google", org_id: orgId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:         GOOGLE_SCOPES,
    access_type:   "offline",
    prompt:        "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function handleGoogleCallback(code) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in:    data.expires_in,
    scope:         data.scope,
  };
}

export async function refreshGoogleToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_in:   data.expires_in,
  };
}

// ── Microsoft OAuth ────────────────────────────────────────
const MS_AUTH_URL  = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_SCOPES    = "Mail.Read Mail.ReadWrite offline_access";

export function buildMicrosoftAuthUrl(orgId) {
  const state = signState({ provider: "microsoft", org_id: orgId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_ID,
    redirect_uri:  MS_REDIRECT_URI,
    response_type: "code",
    scope:         MS_SCOPES,
    response_mode: "query",
    prompt:        "consent",
    state,
  });
  return `${MS_AUTH_URL}?${params}`;
}

export async function handleMicrosoftCallback(code) {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      redirect_uri:  MS_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in:    data.expires_in,
    scope:         data.scope,
  };
}

export async function refreshMicrosoftToken(refreshToken) {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type:    "refresh_token",
      scope:         MS_SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_in:   data.expires_in,
  };
}

// ── SSO Login (OpenID Connect) ──────────────────────────────
// Separate from the email-integration OAuth above.
// These use openid scopes to get an id_token with user profile info.

const GOOGLE_SSO_REDIRECT_URI = process.env.GOOGLE_SSO_REDIRECT_URI || "";
const MS_SSO_REDIRECT_URI     = process.env.MICROSOFT_SSO_REDIRECT_URI || "";

const GOOGLE_SSO_SCOPES = "openid email profile";
const MS_SSO_SCOPES     = "openid email profile offline_access";

export function buildGoogleSsoUrl() {
  const state = signState({ provider: "google_sso", ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_SSO_REDIRECT_URI,
    response_type: "code",
    scope:         GOOGLE_SSO_SCOPES,
    access_type:   "online",
    prompt:        "select_account",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function handleGoogleSsoCallback(code) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_SSO_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google SSO token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // Decode id_token (JWT) — we only need the payload, no signature check
  // since it came directly from Google over TLS.
  const payload = decodeJwtPayload(data.id_token);
  return {
    email: payload.email,
    name:  payload.name || payload.email,
    sub:   payload.sub,
  };
}

export function buildMicrosoftSsoUrl() {
  const state = signState({ provider: "microsoft_sso", ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     MS_CLIENT_ID,
    redirect_uri:  MS_SSO_REDIRECT_URI,
    response_type: "code",
    scope:         MS_SSO_SCOPES,
    response_mode: "query",
    prompt:        "select_account",
    state,
  });
  return `${MS_AUTH_URL}?${params}`;
}

export async function handleMicrosoftSsoCallback(code) {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      redirect_uri:  MS_SSO_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft SSO token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const payload = decodeJwtPayload(data.id_token);
  return {
    email: payload.email || payload.preferred_username,
    name:  payload.name || payload.email || payload.preferred_username,
    sub:   payload.sub,
  };
}

// Decode JWT payload without verification (used for IdP id_tokens received over TLS)
function decodeJwtPayload(jwt) {
  const parts = (jwt || "").split(".");
  if (parts.length < 2) throw new Error("Invalid id_token");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}
