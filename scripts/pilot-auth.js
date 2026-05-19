#!/usr/bin/env node
import 'dotenv/config';
import http from 'node:http';
import { exec } from 'node:child_process';
import { buildOAuthClient, saveToken } from '../src/gmail.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const oauth = buildOAuthClient(process.env);

const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\nOpening browser for Gmail OAuth consent…');
console.log(`If it does not open automatically, visit:\n${authUrl}\n`);

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${opener} "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3001`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('no code'); return; }
  try {
    const { tokens } = await oauth.getToken(code);
    saveToken(TOKEN_PATH, tokens);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>OAuth complete</h1><p>You can close this window.</p>');
    console.log(`\nTokens saved to ${TOKEN_PATH}`);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500); res.end(`error: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(3001, () => console.log('Listening on http://localhost:3001 for OAuth callback…'));
