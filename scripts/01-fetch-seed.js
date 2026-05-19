#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchSeed } from '../src/seed.js';

const out = 'data/seed-municipalities.json';
const seed = await fetchSeed({ log: (m) => console.log(m) });

if (seed.length < 280) {
  console.error(`\nWARNING: expected ~290 kommuner, got ${seed.length}`);
  console.error('Check that the Wikipedia list page layout has not changed.');
}

mkdirSync('data', { recursive: true });
writeFileSync(out, JSON.stringify(seed, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${seed.length} records to ${out}`);
