#!/usr/bin/env node
// One-off: re-apply isPersonalEmail and classifyRole to the existing
// data/municipalities.json so we benefit from C1/C2 fixes without a
// 15-minute re-crawl. Recomputes confidence after reclassification.
//
// Safe to run multiple times — it only filters and relabels existing
// records; it never adds new contacts.

import { isPersonalEmail, isValidEmail } from '../src/crawl.js';
import { classifyRole } from '../src/classify.js';
import { computeConfidence } from '../src/confidence.js';
import {
  loadMunicipalities,
  saveMunicipalities,
  writeSummaryCsv,
  writeContactsCsv,
} from '../src/store.js';

const records = loadMunicipalities('data/municipalities.json');
let removed = 0;
let reclassified = 0;
let confidenceChanged = 0;

for (const r of records) {
  const prevConfidence = r.confidence;
  const kept = [];
  for (const c of r.contacts) {
    if (!isValidEmail(c.email) || isPersonalEmail(c.email)) {
      removed++;
      continue;
    }
    const newRole = classifyRole({
      url: c.source_url ?? '',
      pageTitle: '',
      headings: c.forvaltning_namn ? [c.forvaltning_namn] : [],
      email: c.email,
    });
    if (newRole !== c.role) {
      reclassified++;
      c.role = newRole;
    }
    kept.push(c);
  }
  r.contacts = kept;
  r.confidence = computeConfidence(r.contacts);
  if (r.confidence !== prevConfidence) confidenceChanged++;
}

saveMunicipalities('data/municipalities.json', records);
await writeSummaryCsv('data/municipalities.csv', records);
await writeContactsCsv('data/municipalities-contacts.csv', records);

const counts = records.reduce((acc, r) => {
  acc[r.confidence] = (acc[r.confidence] ?? 0) + 1;
  return acc;
}, {});

console.log(`Removed contacts: ${removed}`);
console.log(`Reclassified contacts: ${reclassified}`);
console.log(`Kommuner with confidence change: ${confidenceChanged}`);
console.log(`New confidence distribution:`, counts);
console.log(`Total kommuner: ${records.length}`);
console.log(`Total contacts: ${records.reduce((n, r) => n + r.contacts.length, 0)}`);
