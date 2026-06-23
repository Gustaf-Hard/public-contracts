import { describe, it, expect } from 'vitest';
import { buildConsentUrl, OAUTH_SCOPES } from '../src/gmail-auth.js';

const env = {
  GMAIL_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GMAIL_OAUTH_CLIENT_SECRET: 'secret',
  GMAIL_OAUTH_REDIRECT_URI: 'http://localhost:47829/oauth2callback',
};

describe('gmail-auth', () => {
  it('exposes the three Gmail scopes', () => {
    expect(OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(OAUTH_SCOPES.length).toBe(3);
  });

  it('buildConsentUrl returns a Google consent URL with client, redirect and scopes', () => {
    const url = buildConsentUrl(env);
    expect(url).toContain('accounts.google.com');
    expect(url).toContain(encodeURIComponent(env.GMAIL_OAUTH_REDIRECT_URI));
    expect(url).toContain(encodeURIComponent(env.GMAIL_OAUTH_CLIENT_ID));
    expect(url).toContain('gmail.readonly');
    expect(url).toContain('access_type=offline');
  });
});
