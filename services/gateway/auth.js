// auth.js — JWT (HMAC-SHA256), bcrypt passwords, refresh tokens, auth middleware
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcrypt";
import { safeQuery } from "@etdp/shared/mysql";

// ── Config ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString("hex");
const ACCESS_TTL = Number(process.env.ACCESS_TTL || 3600);        // 1 hour
const REFRESH_TTL = Number(process.env.REFRESH_TTL || 2592000);   // 30 days
const BCRYPT_ROUNDS = 12;
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";

// ── JWT (hand-rolled HMAC-SHA256, same pattern as oauth.js signState) ──
function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString("base64url");
}

function fromBase64url(str) {
  return Buffer.from(str, "base64url");
}

export function createAccessToken(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + ACCESS_TTL,
  }));
  const sig = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyAccessToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  const sigBuf = fromBase64url(sig);
  const expBuf = fromBase64url(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromBase64url(body).toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Passwords ───────────────────────────────────────────────
export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── Refresh Tokens ──────────────────────────────────────────
export function generateRefreshToken() {
  return randomBytes(32).toString("hex");
}

export function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function storeRefreshToken(userId, rawToken) {
  const hash = hashRefreshToken(rawToken);
  const expires = new Date(Date.now() + REFRESH_TTL * 1000);
  await safeQuery(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, hash, expires],
  );
}

export async function validateRefreshToken(rawToken) {
  const hash = hashRefreshToken(rawToken);
  const r = await safeQuery(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked,
            u.email, u.name
     FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
     WHERE rt.token_hash = ? LIMIT 1`,
    [hash],
  );
  if (!r.ok || r.rows.length === 0) return null;
  const row = r.rows[0];
  if (row.revoked || new Date(row.expires_at) < new Date()) return null;
  return { userId: row.user_id, email: row.email, name: row.name };
}

export async function revokeRefreshToken(rawToken) {
  const hash = hashRefreshToken(rawToken);
  await safeQuery(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`, [hash]);
}

// ── User Org Memberships ────────────────────────────────────
export async function getUserOrgs(userId) {
  const r = await safeQuery(
    `SELECT org_id, role FROM user_orgs WHERE user_id = ?`,
    [userId],
  );
  return r.ok ? r.rows : [];
}

// ── Cookies ─────────────────────────────────────────────────
export function setAuthCookies(res, accessToken, refreshToken) {
  const base = `HttpOnly; SameSite=Lax; Path=/`;
  const sec = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `access_token=${accessToken}; ${base}; Max-Age=${ACCESS_TTL}${sec}`,
    `refresh_token=${refreshToken}; ${base}; Max-Age=${REFRESH_TTL}${sec}`,
  ]);
}

export function clearAuthCookies(res) {
  const base = `HttpOnly; SameSite=Lax; Path=/`;
  const sec = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `access_token=; ${base}; Max-Age=0${sec}`,
    `refresh_token=; ${base}; Max-Age=0${sec}`,
  ]);
}

// ── Middleware ───────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const token = req.cookies?.access_token;
  const payload = verifyAccessToken(token);
  if (!payload) {
    // API routes get 401; page routes redirect to login
    if (req.originalUrl.startsWith("/v1") || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "authentication required" });
    }
    return res.redirect("/login");
  }
  req.user = payload;
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    const orgId = req.params.id || req.params.org_id || req.body?.org_id || req.query?.org_id;
    if (!orgId) return res.status(400).json({ error: "org_id required" });
    const membership = req.user.orgs?.find((o) => o.org_id === orgId);
    if (!membership) return res.status(403).json({ error: "not a member of this org" });
    if (role === "admin" && membership.role !== "admin") {
      return res.status(403).json({ error: "admin role required" });
    }
    next();
  };
}

// ── Cookie Parser (inline, no npm dep) ──────────────────────
export function cookieParser(req, _res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const pair of header.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        req.cookies[key] = decodeURIComponent(val);
      }
    }
  }
  next();
}

// ── Issue tokens helper ─────────────────────────────────────
export async function issueTokens(res, user) {
  const orgs = await getUserOrgs(user.id);
  const accessToken = createAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    orgs,
  });
  const refreshToken = generateRefreshToken();
  await storeRefreshToken(user.id, refreshToken);
  setAuthCookies(res, accessToken, refreshToken);
  return { accessToken, refreshToken };
}
