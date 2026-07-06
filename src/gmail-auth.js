// Gmail OAuth (re-)authorization flow, shared by the `pilot-auth` CLI and the
// dashboard's in-app "Återanslut Gmail" button. The consent screen redirects
// back to GMAIL_OAUTH_REDIRECT_URI (a dedicated localhost port); we run a
// one-shot HTTP listener there to catch the `?code`, exchange it for tokens,
// and persist them via saveToken.

import http from 'node:http';
import crypto from 'node:crypto';
import { buildOAuthClient, saveToken } from './gmail.js';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

// The Google consent URL the operator must visit to grant access.
export function buildConsentUrl(env, scopes = OAUTH_SCOPES) {
  return buildOAuthClient(env).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });
}

// Start the re-auth flow. Returns the consent URL plus a `done` promise that
// resolves once the OAuth callback has been received and tokens saved (or
// rejects on error / timeout). The caller opens/shows `consentUrl`; the
// listener on the redirect port handles the rest and then shuts itself down.
export function beginReauth({ env, tokenPath, scopes = OAUTH_SCOPES, timeoutMs = 5 * 60 * 1000 }) {
  const oauth = buildOAuthClient(env);
  // CSRF + code-injection hardening (review L3): a random `state` the callback
  // must echo, and PKCE (S256) so an injected authorization code is useless
  // without the in-process verifier.
  const expectedState = b64url(crypto.randomBytes(16));
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const consentUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: expectedState,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const redirectUri = new URL(env.GMAIL_OAUTH_REDIRECT_URI);
  const callbackPath = redirectUri.pathname;
  const callbackPort = parseInt(redirectUri.port || '80', 10);

  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri.origin);
    if (url.pathname !== callbackPath) {
      res.writeHead(404); res.end('not found'); return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400); res.end('no code');
      cleanup(); reject(new Error('OAuth callback received without a code'));
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400); res.end('state mismatch');
      cleanup(); reject(new Error('OAuth callback state mismatch — possible CSRF, flow aborted'));
      return;
    }
    try {
      const { tokens } = await oauth.getToken({ code, codeVerifier });
      saveToken(tokenPath, tokens);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Klart ✅</h1><p>Gmail återanslutet. Du kan stänga den här fliken.</p>');
      cleanup(); resolve({ ok: true });
    } catch (e) {
      res.writeHead(500); res.end(`error: ${e.message}`);
      cleanup(); reject(e);
    }
  });

  const timer = setTimeout(() => {
    cleanup();
    reject(new Error('OAuth flow timed out'));
  }, timeoutMs);

  function cleanup() {
    clearTimeout(timer);
    server.close();
  }

  server.on('error', (e) => { cleanup(); reject(e); });
  server.listen(callbackPort);

  return { consentUrl, done };
}
