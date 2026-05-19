#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadMunicipalities } from '../src/store.js';
import { verifyAll, buildReviewReport } from '../src/verify.js';

const records = loadMunicipalities('data/municipalities.json');
if (records.length === 0) {
  console.error('data/municipalities.json is empty — run npm run discover first.');
  process.exit(1);
}

console.log(`Verifying ${records.length} kommuner...`);
const { invalidSyntax, missingMx } = await verifyAll(records);
console.log(`Invalid syntax: ${invalidSyntax.length}`);
console.log(`Missing MX: ${missingMx.length}`);
for (const c of invalidSyntax) console.log(`  syntax: ${c.kod} ${c.kommun} -- ${c.email}`);
for (const c of missingMx) console.log(`  no MX: ${c.kod} ${c.kommun} -- ${c.email} (${c.domain})`);

const report = buildReviewReport(records);
mkdirSync('data', { recursive: true });
writeFileSync('data/review-report.md', report, 'utf8');
console.log('\nReview report written to data/review-report.md');
