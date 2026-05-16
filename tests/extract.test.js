import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractEmails, deobfuscate } from '../src/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('deobfuscate', () => {
  it('replaces [at] (case insensitive)', () => {
    expect(deobfuscate('foo [at] bar.se')).toBe('foo@bar.se');
    expect(deobfuscate('foo [AT] bar.se')).toBe('foo@bar.se');
  });
  it('replaces (at) and (dot)', () => {
    expect(deobfuscate('foo (at) bar (dot) se')).toBe('foo@bar.se');
  });
  it('replaces HTML entity &#64;', () => {
    expect(deobfuscate('foo&#64;bar.se')).toBe('foo@bar.se');
  });
});

describe('extractEmails', () => {
  it('finds mailto: links and ignores query strings', () => {
    const res = extractEmails(fixture('extract-mailto-with-query.html'), 'https://k.se/x');
    expect(res.map((r) => r.email)).toContain('registrator@kommun.se');
    expect(res[0].source_url).toBe('https://k.se/x');
  });

  it('finds emails in plain text and via mailto, deduped, lowercased', () => {
    const res = extractEmails(fixture('extract-plain.html'), 'https://k.se/');
    const emails = res.map((r) => r.email).sort();
    expect(emails).toEqual(['kontakt@example.se', 'registrator@example.se']);
  });

  it('finds obfuscated emails', () => {
    const res = extractEmails(fixture('extract-obfuscated.html'), 'https://k.se/');
    const emails = res.map((r) => r.email).sort();
    expect(emails).toContain('registrator@kommun.se');
    expect(emails).toContain('barn@kommun.se');
    expect(emails).toContain('skol@kommun.se');
  });

  it('returns empty array when no emails present', () => {
    const res = extractEmails('<html><body>nothing here</body></html>', 'https://k.se/');
    expect(res).toEqual([]);
  });
});
