#!/usr/bin/env node
// Merge folkmangd from seed into the canonical municipalities.json.
// Safe to re-run.

import { readFileSync } from 'node:fs';
import {
  loadMunicipalities,
  saveMunicipalities,
  writeSummaryCsv,
  writeContactsCsv,
} from '../src/store.js';

const seed = JSON.parse(readFileSync('data/seed-municipalities.json', 'utf8'));
const records = loadMunicipalities('data/municipalities.json');
const folkmangdByKod = new Map(seed.map((s) => [s.kommun_kod, s.folkmangd ?? null]));

let updated = 0;
for (const r of records) {
  const f = folkmangdByKod.get(r.kommun_kod) ?? null;
  if (r.folkmangd !== f) {
    r.folkmangd = f;
    updated++;
  }
}

saveMunicipalities('data/municipalities.json', records);
await writeSummaryCsv('data/municipalities.csv', records);
await writeContactsCsv('data/municipalities-contacts.csv', records);

console.log(`Updated folkmangd on ${updated} kommun records.`);
console.log(`Total kommuner: ${records.length}`);
console.log(`With folkmangd: ${records.filter((r) => r.folkmangd != null).length}`);
