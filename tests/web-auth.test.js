import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  signSession, verifySession, parseCookies, serializeCookie, isAllowedEmail,
  requireAuth, requireOriginToken, mountAuthRoutes,
  SESSION_COOKIE, TX_COOKIE, SESSION_MAX_AGE_MS,
} from '../src/web-auth.js';

const SECRET = 'test-session-secret-xyz';

// Manual server + fetch (project convention: no supertest). redirect:'manual'
// so we can assert on 3xx Location + Set-Cookie headers.
function request(app, path, { method = 'GET', headers = {}, redirect = 'manual' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, { method, headers, redirect })
        .then(async (r) => {
          const text = await r.text();
          server.close(() => resolve({
            status: r.status,
            location: r.headers.get('location'),
            setCookie: r.headers.get('set-cookie'),
            text,
          }));
        })
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

describe('signed session cookie', () => {
  it('round-trips a payload', () => {
    const token = signSession({ email: 'a@b.se', iat: 1000 }, SECRET);
    expect(verifySession(token, SECRET)).toEqual({ email: 'a@b.se', iat: 1000 });
  });

  it('rejects a tampered body', () => {
    const token = signSession({ email: 'a@b.se', iat: 1000 }, SECRET);
    const [body, sig] = token.split('.');
    const forged = `${body}x.${sig}`;
    expect(verifySession(forged, SECRET)).toBeNull();
  });

  it('rejects a wrong secret', () => {
    const token = signSession({ email: 'a@b.se', iat: 1000 }, SECRET);
    expect(verifySession(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired session', () => {
    const iat = 1_000_000;
    const token = signSession({ email: 'a@b.se', iat }, SECRET);
    const now = iat + SESSION_MAX_AGE_MS + 1;
    expect(verifySession(token, SECRET, { maxAgeMs: SESSION_MAX_AGE_MS, now })).toBeNull();
  });

  it('rejects a future-dated session', () => {
    const now = 1_000_000;
    const token = signSession({ email: 'a@b.se', iat: now + 5 * 60_000 }, SECRET);
    expect(verifySession(token, SECRET, { maxAgeMs: SESSION_MAX_AGE_MS, now })).toBeNull();
  });

  it('accepts a session within the window', () => {
    const now = 5_000_000;
    const token = signSession({ email: 'a@b.se', iat: now - 1000 }, SECRET);
    expect(verifySession(token, SECRET, { maxAgeMs: SESSION_MAX_AGE_MS, now })).toEqual({ email: 'a@b.se', iat: now - 1000 });
  });

  it('rejects junk', () => {
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('nodot', SECRET)).toBeNull();
    expect(verifySession(null, SECRET)).toBeNull();
  });
});

describe('parseCookies / isAllowedEmail', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=two%20words; c=')).toEqual({ a: '1', b: 'two words', c: '' });
  });
  it('handles no header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
  it('matches operator email case/space-insensitively', () => {
    expect(isAllowedEmail('  Op@Example.SE ', 'op@example.se')).toBe(true);
    expect(isAllowedEmail('evil@example.se', 'op@example.se')).toBe(false);
    expect(isAllowedEmail('', 'op@example.se')).toBe(false);
    expect(isAllowedEmail('op@example.se', '')).toBe(false);
  });
});

function gatedApp(env) {
  const app = express();
  app.use(requireAuth({ env }));
  app.get('/secret', (req, res) => res.send(`ok ${req.operator ?? ''}`.trim()));
  app.post('/secret', (req, res) => res.send('posted'));
  return app;
}

describe('requireAuth middleware', () => {
  it('is inert when AUTH_ENABLED is not set', async () => {
    const r = await request(gatedApp({}), '/secret');
    expect(r.status).toBe(200);
    expect(r.text).toBe('ok');
  });

  it('redirects an unauthenticated GET to /auth/login', async () => {
    const env = { AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se' };
    const r = await request(gatedApp(env), '/secret');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login');
  });

  it('401s an unauthenticated POST', async () => {
    const env = { AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se' };
    const r = await request(gatedApp(env), '/secret', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  it('admits a valid session for the operator', async () => {
    const env = { AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se' };
    const token = signSession({ email: 'op@example.se', iat: Date.now() }, SECRET);
    const r = await request(gatedApp(env), '/secret', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(r.status).toBe(200);
    expect(r.text).toBe('ok op@example.se');
  });

  it('rejects a valid session for a NON-operator email', async () => {
    const env = { AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se' };
    const token = signSession({ email: 'intruder@example.se', iat: Date.now() }, SECRET);
    const r = await request(gatedApp(env), '/secret', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login');
  });
});

describe('requireOriginToken middleware', () => {
  function app(env) {
    const a = express();
    a.use(requireOriginToken({ env }));
    a.get('/', (req, res) => res.send('ok'));
    return a;
  }
  it('passes through when ORIGIN_TOKEN unset', async () => {
    expect((await request(app({}), '/')).status).toBe(200);
  });
  it('403s when the header is missing', async () => {
    expect((await request(app({ ORIGIN_TOKEN: 'sekret' }), '/')).status).toBe(403);
  });
  it('403s on a wrong header', async () => {
    const r = await request(app({ ORIGIN_TOKEN: 'sekret' }), '/', { headers: { 'X-Origin-Token': 'nope' } });
    expect(r.status).toBe(403);
  });
  it('admits the correct header', async () => {
    const r = await request(app({ ORIGIN_TOKEN: 'sekret' }), '/', { headers: { 'X-Origin-Token': 'sekret' } });
    expect(r.status).toBe(200);
  });
});

describe('OAuth login/callback routes (offline via injected oauthOps)', () => {
  const env = {
    AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se',
  };

  function makeApp({ oauthOps, saved }) {
    const app = express();
    mountAuthRoutes(app, {
      env,
      tokenPath: '/tmp/ignored-token.json',
      oauthOps,
      saveTokenImpl: (p, t) => { saved.token = t; },
      loadTokenImpl: () => ({ refresh_token: 'old' }),
      now: () => 1_000_000,
    });
    return app;
  }

  it('/auth/login sets a tx cookie and redirects to the consent URL', async () => {
    const saved = {};
    const app = makeApp({ saved, oauthOps: {
      buildAuthUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchangeCode: async () => ({ tokens: {}, email: '' }),
    }});
    const r = await request(app, '/auth/login');
    expect(r.status).toBe(302);
    expect(r.location).toContain('accounts.google.com');
    expect(r.setCookie).toContain(`${TX_COOKIE}=`);
    expect(r.setCookie).toContain('HttpOnly');
  });

  it('completes a happy-path callback: allowed email → session cookie + token saved', async () => {
    const saved = {};
    // Reuse the tx cookie minted by /auth/login so state matches.
    const app = makeApp({ saved, oauthOps: {
      buildAuthUrl: ({ state }) => `https://x/?state=${encodeURIComponent(state)}`,
      exchangeCode: async ({ code, codeVerifier }) => {
        expect(code).toBe('abc');
        expect(codeVerifier).toBeTruthy();
        return { tokens: { refresh_token: 'new-rt', access_token: 'at' }, email: 'op@example.se' };
      },
    }});
    const login = await request(app, '/auth/login');
    const txCookie = login.setCookie.split(';')[0]; // mg_oauth_tx=...
    const state = decodeURIComponent(new URL(login.location).searchParams.get('state'));
    const cb = await request(app, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: txCookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/');
    expect(cb.setCookie).toContain(`${SESSION_COOKIE}=`);
    // token merged + persisted as the send credential
    expect(saved.token).toEqual({ refresh_token: 'new-rt', access_token: 'at' });
  });

  it('rejects a callback for a non-operator email with 403 and saves no token', async () => {
    const saved = {};
    const app = makeApp({ saved, oauthOps: {
      buildAuthUrl: ({ state }) => `https://x/?state=${encodeURIComponent(state)}`,
      exchangeCode: async () => ({ tokens: { refresh_token: 'x' }, email: 'intruder@example.se' }),
    }});
    const login = await request(app, '/auth/login');
    const txCookie = login.setCookie.split(';')[0];
    const state = decodeURIComponent(new URL(login.location).searchParams.get('state'));
    const cb = await request(app, `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: txCookie },
    });
    expect(cb.status).toBe(403);
    expect(saved.token).toBeUndefined();
  });

  it('rejects a callback whose state does not match the tx cookie', async () => {
    const saved = {};
    const app = makeApp({ saved, oauthOps: {
      buildAuthUrl: ({ state }) => `https://x/?state=${encodeURIComponent(state)}`,
      exchangeCode: async () => ({ tokens: {}, email: 'op@example.se' }),
    }});
    const login = await request(app, '/auth/login');
    const txCookie = login.setCookie.split(';')[0];
    const cb = await request(app, '/auth/callback?code=abc&state=WRONG', { headers: { cookie: txCookie } });
    expect(cb.status).toBe(400);
    expect(saved.token).toBeUndefined();
  });

  it('logout clears the session cookie', async () => {
    const saved = {};
    const app = makeApp({ saved, oauthOps: { buildAuthUrl: () => 'x', exchangeCode: async () => ({}) } });
    const r = await request(app, '/auth/logout');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login');
    expect(r.setCookie).toContain(`${SESSION_COOKIE}=;`);
  });

  it('throws at mount if AUTH_ENABLED without SESSION_SECRET', () => {
    expect(() => mountAuthRoutes(express(), { env: { AUTH_ENABLED: '1' } })).toThrow(/SESSION_SECRET/);
  });
});
