#!/usr/bin/env node
import 'dotenv/config';
import { exec } from 'node:child_process';
import { beginReauth } from '../src/gmail-auth.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;

const { consentUrl, done } = beginReauth({ env: process.env, tokenPath: TOKEN_PATH });

console.log('\nOpening browser for Gmail OAuth consent…');
console.log(`If it does not open automatically, visit:\n${consentUrl}\n`);
const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${opener} "${consentUrl}"`);

try {
  await done;
  console.log(`\nTokens saved to ${TOKEN_PATH}`);
  process.exit(0);
} catch (e) {
  console.error(`\nOAuth failed: ${e.message}`);
  process.exit(1);
}
