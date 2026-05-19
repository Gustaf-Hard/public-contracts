#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/storage.js';
import { loadOverrides, resolveActiveKommuner } from '../src/pilot-config.js';

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const overrides = loadOverrides();
const live = JSON.parse(readFileSync('data/municipalities.json', 'utf8'));
const active = resolveActiveKommuner(overrides, live);

if (active.length === 0) {
  console.error('No active kommuner — check data/pilot-overrides.json');
  process.exit(1);
}

const db = openDb(DB_PATH);
db.migrate();

const today = new Date();
today.setHours(10, 0, 0, 0);

const ELIGIBLE_ROLES = new Set(['central', 'utbildning', 'gymnasie', 'vuxenutbildning']);

let created = 0;
let skipped = 0;
active.forEach((kommun, dayIdx) => {
  const scheduledSendAt = new Date(today);
  scheduledSendAt.setDate(today.getDate() + dayIdx);
  const seenRoles = new Set();
  for (const c of kommun.contacts) {
    if (!ELIGIBLE_ROLES.has(c.role)) continue;
    const roleKey = c.role === 'gymnasie' || c.role === 'vuxenutbildning' ? 'utbildning' : c.role;
    if (seenRoles.has(roleKey)) continue;
    seenRoles.add(roleKey);
    try {
      db.createConversation({
        kommun_kod: kommun.kommun_kod,
        kommun_namn: kommun.kommun_namn,
        role: roleKey,
        contact_email: c.email,
        scheduled_send_at: scheduledSendAt.toISOString(),
      });
      created++;
    } catch (e) {
      if (/UNIQUE/.test(e.message)) { skipped++; continue; }
      throw e;
    }
  }
});

console.log(`Created ${created} conversations, skipped ${skipped} duplicates.`);
console.log(`First dispatch: ${today.toISOString()}; last: day +${active.length - 1}`);
db.close();
