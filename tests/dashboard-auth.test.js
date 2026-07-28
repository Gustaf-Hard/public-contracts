import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { signSession, SESSION_COOKIE } from '../src/web-auth.js';

// Integration: the gate protects REAL dashboard routes (not just the isolated
// middleware). AUTH_ENABLED flips it on; without it the loopback dashboard and
// the rest of the suite stay untouched.

const SECRET = 'integration-secret';
let tmp, db, muniPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dash-auth-'));
  muniPath = join(tmp, 'municipalities.json');
  writeFileSync(muniPath, JSON.stringify([
    { kommun_kod: '2418', kommun_namn: 'Malå', lan: 'Västerbottens län', folkmangd: 2902, contacts: [] },
  ]));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function app(env) {
  return createDashboardApp({
    db,
    municipalitiesLoader: () => JSON.parse(require('node:fs').readFileSync(muniPath, 'utf8')),
    env,
    slackClient: null,
    gmailClient: null,
    // Never build a real OAuth client in tests.
    authDeps: { oauthOps: { buildAuthUrl: () => 'https://accounts.google.com/x', exchangeCode: async () => ({}) } },
  });
}

function req(a, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', headers })
        .then((r) => server.close(() => resolve({ status: r.status, location: r.headers.get('location') })))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

const AUTH_ENV = { AUTH_ENABLED: '1', SESSION_SECRET: SECRET, GMAIL_USER_EMAIL: 'op@example.se' };

describe('dashboard behind the auth gate', () => {
  it('redirects an unauthenticated request for / to /auth/login', async () => {
    const r = await req(app(AUTH_ENV), '/');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/auth/login');
  });

  it('serves / for an authenticated operator', async () => {
    const cookie = `${SESSION_COOKIE}=${signSession({ email: 'op@example.se', iat: Date.now() }, SECRET)}`;
    const r = await req(app(AUTH_ENV), '/', { cookie });
    expect(r.status).toBe(200);
  });

  it('leaves the dashboard open when AUTH_ENABLED is unset (loopback default)', async () => {
    const r = await req(app({}), '/');
    expect(r.status).toBe(200);
  });
});
