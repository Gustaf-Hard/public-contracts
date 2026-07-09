import { describe, it, expect } from 'vitest';
import { parseArgs } from '../scripts/07-reanalyse-lifecycle.js';

describe('07-reanalyse-lifecycle parseArgs (pure)', () => {
  it('defaults: no dry-run, no db override, no onlyId', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, dbPath: null, onlyId: null });
  });
  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });
  it('parses --db= override', () => {
    expect(parseArgs(['--db=/tmp/x.db']).dbPath).toBe('/tmp/x.db');
  });
  it('parses --only= as an integer attachment id', () => {
    expect(parseArgs(['--only=42']).onlyId).toBe(42);
  });
  it('ignores a non-numeric --only=', () => {
    expect(parseArgs(['--only=abc']).onlyId).toBeNull();
  });
});
