#!/usr/bin/env node
import pLimit from 'p-limit';
import { readFileSync } from 'node:fs';
import { crawlKommun } from '../src/crawl.js';
import { loadMunicipalities, saveMunicipalities, writeSummaryCsv, writeContactsCsv } from '../src/store.js';

const seedPath = 'data/seed-municipalities.json';
const outJson = 'data/municipalities.json';
const outSummary = 'data/municipalities.csv';
const outContacts = 'data/municipalities-contacts.csv';

const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const existing = loadMunicipalities(outJson);
const existingByKod = new Map(existing.map((r) => [r.kommun_kod, r]));

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyKods = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

// Skip already-processed municipalities unless --force is passed
const forceArg = process.argv.includes('--force');
const target = onlyKods
  ? seed.filter((s) => onlyKods.includes(s.kommun_kod))
  : forceArg
    ? seed
    : seed.filter((s) => !existingByKod.has(s.kommun_kod));
const today = new Date().toISOString().slice(0, 10);

const limit = pLimit(4); // up to 4 different hosts in flight
const byKod = new Map(existingByKod);
let completed = 0;

// Save incrementally every N completed records to handle interruptions gracefully
const SAVE_INTERVAL = 20;

async function saveNow() {
  const merged = [...byKod.values()].sort((a, b) => a.kommun_kod.localeCompare(b.kommun_kod));
  saveMunicipalities(outJson, merged);
  await writeSummaryCsv(outSummary, merged);
  await writeContactsCsv(outContacts, merged);
}

const results = await Promise.all(
  target.map((s) =>
    limit(async () => {
      const start = Date.now();
      let record;
      try {
        record = await crawlKommun(s, { today });
        const ms = Date.now() - start;
        console.log(
          `${s.kommun_kod} ${s.kommun_namn}: ${record.contacts.length} contacts (${record.confidence}) in ${ms}ms`
        );
      } catch (e) {
        console.error(`${s.kommun_kod} ${s.kommun_namn}: ERROR ${e.message}`);
        record = {
          kommun_kod: s.kommun_kod,
          kommun_namn: s.kommun_namn,
          lan: s.lan,
          org_nr: s.org_nr ?? null,
          webbplats: s.webbplats ?? null,
          diarium_url: null,
          contacts: [],
          confidence: 'low',
          notes: `crawl error: ${e.message}`,
          verified_at: today,
        };
      }
      byKod.set(record.kommun_kod, record);
      completed++;
      if (completed % SAVE_INTERVAL === 0) {
        await saveNow();
        console.error(`[checkpoint] saved ${completed}/${target.length}`);
      }
      return record;
    })
  )
);

const merged = [...byKod.values()].sort((a, b) => a.kommun_kod.localeCompare(b.kommun_kod));

await saveNow();

const counts = merged.reduce((acc, r) => {
  acc[r.confidence] = (acc[r.confidence] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nDone. ${merged.length} kommuner total. Confidence:`, counts);
