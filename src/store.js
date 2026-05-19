import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'csv-stringify';

export function loadMunicipalities(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveMunicipalities(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n', 'utf8');
}

function stringifyCsv(rows, columns) {
  return new Promise((resolve, reject) => {
    stringify(rows, { header: true, columns }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

export async function writeSummaryCsv(path, records) {
  const rows = records.map((r) => ({
    kommun_kod: r.kommun_kod,
    kommun_namn: r.kommun_namn,
    lan: r.lan,
    org_nr: r.org_nr,
    webbplats: r.webbplats,
    folkmangd: r.folkmangd ?? '',
    diarium_url: r.diarium_url ?? '',
    contact_count: r.contacts.length,
    confidence: r.confidence,
    verified_at: r.verified_at,
    notes: r.notes ?? '',
  }));
  const columns = [
    'kommun_kod', 'kommun_namn', 'lan', 'org_nr', 'webbplats',
    'folkmangd', 'diarium_url', 'contact_count', 'confidence', 'verified_at', 'notes',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await stringifyCsv(rows, columns), 'utf8');
}

export async function writeContactsCsv(path, records) {
  const rows = [];
  for (const r of records) {
    for (const c of r.contacts) {
      rows.push({
        kommun_kod: r.kommun_kod,
        kommun_namn: r.kommun_namn,
        email: c.email,
        role: c.role,
        forvaltning_namn: c.forvaltning_namn ?? '',
        source_url: c.source_url,
        found_via: c.found_via,
      });
    }
  }
  const columns = [
    'kommun_kod', 'kommun_namn', 'email', 'role',
    'forvaltning_namn', 'source_url', 'found_via',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await stringifyCsv(rows, columns), 'utf8');
}
