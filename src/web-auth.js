// Web auth gate for the dashboard when it is exposed beyond loopback (AWS).
//
// Today the dashboard trusts loopback and has no auth. On a public URL that
// would leak kommun PII and the send controls, so this module gates every
// request behind Google Sign-In restricted to a single operator email.
//
// Design (see docs/superpowers/specs/2026-07-28-aws-deployment-design.md §3):
//   - ONE Google OAuth grant carries identity (openid/email) AND the Gmail
//     send/read scopes, so "logged in ⇒ can send" is literally true: the
//     callback persists the refresh token to the same path the daemon reads.
//   - Session is a stateless HMAC-signed cookie (no server-side store): the
//     operator email + issued-at, signed with SESSION_SECRET.
//   - The whole gate is inert unless AUTH_ENABLED==='1', so loopback dev and
//     the existing test-suite are untouched until we deliberately flip it on.
//
// The OAuth exchange is injectable (`oauthOps`) so login/callback verify fully
// offline in tests, matching the project's dependency-injection pattern.

import crypto from 'node:crypto';
import { google } from 'googleapis';
import { saveToken, loadStoredToken } from './gmail.js';

export const SESSION_COOKIE = 'mg_session';
export const TX_COOKIE = 'mg_oauth_tx';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TX_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — one login round-trip

// openid+email verify who you are; the gmail scopes are what the daemon sends
// with. One consent, one refresh token, both jobs.
export const LOGIN_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

// ---- base64url + HMAC primitives ----

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(secret, body) {
  return b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
}

// ---- stateless signed session cookie ----

// Encode `payload` as a `body.sig` string signed with `secret`. The payload is
// authenticated, not encrypted — never put anything secret in it (we only ever
// store the operator email + iat).
export function signSession(payload, secret) {
  if (!secret) throw new Error('signSession requires a SESSION_SECRET');
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${hmac(secret, body)}`;
}

// Return the payload iff the signature verifies (constant-time) and, when
// `maxAgeMs` is given, `iat` is within the window and not future-dated. Any
// failure returns null — callers treat null as "not authenticated".
export function verifySession(value, secret, { maxAgeMs, now = Date.now() } = {}) {
  if (!value || !secret || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(secret, body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (maxAgeMs != null) {
    const iat = payload && typeof payload.iat === 'number' ? payload.iat : null;
    if (iat == null) return null;
    if (now - iat > maxAgeMs) return null; // expired
    if (iat - now > 60_000) return null; // clock-skew / forged future iat
  }
  return payload;
}

// ---- small HTTP helpers ----

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeMs, secure = false, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}`;
  c += `; Path=${path}`;
  if (maxAgeMs != null) c += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (sameSite) c += `; SameSite=${sameSite}`;
  return c;
}

// Single-operator allowlist: case/space-insensitive exact match.
export function isAllowedEmail(email, allowed) {
  if (!email || !allowed) return false;
  return String(email).trim().toLowerCase() === String(allowed).trim().toLowerCase();
}

export function authEnabled(env) {
  return env.AUTH_ENABLED === '1';
}

// ---- middleware ----

// Gate every request behind a valid session for the allowed operator. Inert
// unless AUTH_ENABLED==='1'. The /auth/* endpoints are always allowed through
// so the login round-trip can complete. GET navigations without a session are
// redirected to /auth/login; other methods get a bare 401 (fail closed).
export function requireAuth({ env = process.env, now = () => Date.now() } = {}) {
  const secret = env.SESSION_SECRET;
  return (req, res, next) => {
    if (!authEnabled(env)) return next();
    if (req.path === '/auth/login' || req.path === '/auth/callback' || req.path === '/auth/logout') {
      return next();
    }
    const cookies = parseCookies(req.headers.cookie);
    const sess = verifySession(cookies[SESSION_COOKIE], secret, { maxAgeMs: SESSION_MAX_AGE_MS, now: now() });
    if (sess && isAllowedEmail(sess.email, env.GMAIL_USER_EMAIL)) {
      req.operator = String(sess.email).toLowerCase();
      return next();
    }
    if (req.method === 'GET') return res.redirect('/auth/login');
    return res.status(401).send('Unauthorized');
  };
}

// When ORIGIN_TOKEN is set, reject any request missing the matching
// X-Origin-Token header. CloudFront injects it, so the EC2 box is unreachable
// except through the distribution. Unset (local dev) → pass through.
export function requireOriginToken({ env = process.env } = {}) {
  const expected = env.ORIGIN_TOKEN;
  return (req, res, next) => {
    if (!expected) return next();
    const got = req.get('X-Origin-Token') ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(403).send('Forbidden');
  };
}

// ---- OAuth ops (default = real googleapis; injectable for tests) ----

function defaultOauthOps(env) {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  const redirectUri = env.WEB_AUTH_REDIRECT_URI;
  const client = () => new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return {
    buildAuthUrl({ state, codeChallenge }) {
      return client().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: LOGIN_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async exchangeCode({ code, codeVerifier }) {
      const c = client();
      const { tokens } = await c.getToken({ code, codeVerifier });
      const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const email = ticket.getPayload()?.email ?? '';
      return { tokens, email };
    },
  };
}

// Mount /auth/login, /auth/callback, /auth/logout on the given Express app.
// The PKCE verifier + CSRF state live in a short-lived signed `tx` cookie
// (stateless — survives the Google round-trip without a server session store).
export function mountAuthRoutes(app, {
  env = process.env,
  tokenPath,
  oauthOps,
  saveTokenImpl = saveToken,
  loadTokenImpl = loadStoredToken,
  now = () => Date.now(),
} = {}) {
  const secret = env.SESSION_SECRET;
  if (authEnabled(env) && !secret) {
    throw new Error('AUTH_ENABLED=1 requires SESSION_SECRET to be set');
  }
  const ops = oauthOps ?? defaultOauthOps(env);
  const secure = env.AUTH_COOKIE_SECURE === '1';
  const cookieOpts = { secure, sameSite: 'Lax' };

  app.get('/auth/login', (req, res) => {
    const state = b64urlEncode(crypto.randomBytes(16));
    const codeVerifier = b64urlEncode(crypto.randomBytes(32));
    const codeChallenge = b64urlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
    const tx = signSession({ state, codeVerifier, iat: now() }, secret);
    res.setHeader('Set-Cookie', serializeCookie(TX_COOKIE, tx, { ...cookieOpts, maxAgeMs: TX_MAX_AGE_MS }));
    res.redirect(ops.buildAuthUrl({ state, codeChallenge }));
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const tx = verifySession(cookies[TX_COOKIE], secret, { maxAgeMs: TX_MAX_AGE_MS, now: now() });
      const code = req.query.code;
      const state = req.query.state;
      if (!tx || !code || !state || state !== tx.state) {
        return res.status(400).send('Ogiltig inloggning. Försök igen via /auth/login.');
      }
      const { tokens, email } = await ops.exchangeCode({ code: String(code), codeVerifier: tx.codeVerifier });
      if (!isAllowedEmail(email, env.GMAIL_USER_EMAIL)) {
        return res.status(403).send('Endast operatören har åtkomst till det här verktyget.');
      }
      // Persist the refresh token as the shared send credential. Merge so a
      // response that omits refresh_token does not wipe an existing one.
      const merged = { ...(loadTokenImpl(tokenPath) ?? {}), ...tokens };
      saveTokenImpl(tokenPath, merged);
      const session = signSession({ email: String(email).toLowerCase(), iat: now() }, secret);
      res.setHeader('Set-Cookie', [
        serializeCookie(SESSION_COOKIE, session, { ...cookieOpts, maxAgeMs: SESSION_MAX_AGE_MS }),
        serializeCookie(TX_COOKIE, '', { ...cookieOpts, maxAgeMs: 0 }),
      ]);
      res.redirect('/');
    } catch {
      res.status(500).send('Inloggning misslyckades. Försök igen.');
    }
  });

  const logout = (req, res) => {
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { ...cookieOpts, maxAgeMs: 0 }));
    res.redirect('/auth/login');
  };
  app.get('/auth/logout', logout);
  app.post('/auth/logout', logout);
}
