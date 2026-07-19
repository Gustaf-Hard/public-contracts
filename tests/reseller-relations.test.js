// tests/reseller-relations.test.js
// Vendor↔ramavtal relationships (2026-07-19 design), offline:
//   - storage read-time helpers (listResellerRelationsForKommun / listResellerRelations)
//   - renderRamavtal pure view
//   - the fill-only, non-destructive backfill script (scripts/10-…) with a fake LLM
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { renderRamavtal } from '../src/dashboard-views.js';
import { resellerBySlug } from '../src/resellers.js';
import {
  mergeResellerRelations,
  runBackfill,
  parseArgs,
} from '../scripts/10-extract-reseller-relations.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reseller-rel-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Enroll a conversation for a kommun and record one inbound message carrying an
// analysis_json blob.
function seedInbound(kommun_kod, kommun_namn, analysis, { gid = 'g-' + Math.random(), body = 'body', role = 'central' } = {}) {
  const cid = db.createConversation({
    kommun_kod, kommun_namn, role, contact_email: 'reg@x.se',
    scheduled_send_at: '2026-05-19T10:00:00Z',
  });
  const mid = db.recordMessage({
    conversation_id: cid, gmail_message_id: gid, direction: 'inbound',
    from_email: 'reg@x.se', to_email: 'gustaf@mediagraf.se', subject: 'Re',
    body_text: body, classification: null, classification_confidence: null,
    received_at: '2026-05-20T10:00:00Z', attachment_count: 0,
    analysis_json: analysis == null ? null : JSON.stringify(analysis),
  });
  return { cid, mid };
}

describe('storage.listResellerRelationsForKommun', () => {
  it('maps vendor(lowercase) → [ramavtal canonical] for stated relations', () => {
    seedInbound('1980', 'Västerås', {
      intent: 'delivery',
      extracted: { mentioned_vendors: ['NE', 'Läromedia'], reseller_relations: [{ vendor: 'NE', ramavtal: 'Läromedia' }] },
    });
    const map = db.listResellerRelationsForKommun('1980');
    expect(map.get('ne')).toEqual(['Läromedia']);
  });

  it('canonicalizes the ramavtal name and drops non-curated ones', () => {
    seedInbound('1980', 'Västerås', {
      extracted: { reseller_relations: [
        { vendor: 'Skola24', ramavtal: 'Atea Sverige AB' }, // → Atea (curated)
        { vendor: 'Foo', ramavtal: 'Någon Grossist AB' },   // not curated → dropped
      ] },
    });
    const map = db.listResellerRelationsForKommun('1980');
    expect(map.get('skola24')).toEqual(['Atea']);
    expect(map.has('foo')).toBe(false);
  });

  it('dedupes ramavtal per vendor across messages', () => {
    seedInbound('1980', 'Västerås', { extracted: { reseller_relations: [{ vendor: 'NE', ramavtal: 'Läromedia' }] } }, { gid: 'a', role: 'central' });
    seedInbound('1980', 'Västerås', { extracted: { reseller_relations: [{ vendor: 'NE', ramavtal: 'laromedia bokhandel örebro' }] } }, { gid: 'b', role: 'utbildning' });
    const map = db.listResellerRelationsForKommun('1980');
    expect(map.get('ne')).toEqual(['Läromedia']);
  });

  it('skips malformed analysis_json safely and returns empty map when no relations', () => {
    // malformed JSON stored directly
    const cid = db.createConversation({ kommun_kod: '1980', kommun_namn: 'V', role: 'central', contact_email: 'r@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.raw.prepare("INSERT INTO messages (conversation_id, gmail_message_id, direction, received_at, attachment_count, analysis_json) VALUES (?, 'gm', 'inbound', '2026-05-20T10:00:00Z', 0, ?)").run(cid, '{not json');
    expect(db.listResellerRelationsForKommun('1980').size).toBe(0);
  });
});

describe('storage.listResellerRelations (all kommuner)', () => {
  it('returns every canonicalized relation across kommuner', () => {
    seedInbound('1980', 'Västerås', { extracted: { reseller_relations: [{ vendor: 'NE', ramavtal: 'Läromedia' }] } }, { gid: 'a' });
    seedInbound('0180', 'Stockholm', { extracted: { reseller_relations: [{ vendor: 'Magma', ramavtal: 'Läromedia' }] } }, { gid: 'b' });
    const rels = db.listResellerRelations();
    expect(rels).toContainEqual({ vendor: 'NE', ramavtal: 'Läromedia' });
    expect(rels).toContainEqual({ vendor: 'Magma', ramavtal: 'Läromedia' });
  });
});

describe('renderRamavtal (pure view)', () => {
  const reseller = resellerBySlug('laromedia');

  it('renders header with the frame icon + canonical name', () => {
    const html = renderRamavtal({ reseller, kommuner: [], vendors: [] });
    expect(html).toContain('Läromedia');
    expect(html).toContain('frame-icon'); // inline SVG frame glyph
  });

  it('lists kommuner-via linking to /kommun/:kod and vendors-through linking to vendor pages when present', () => {
    const html = renderRamavtal({
      reseller,
      kommuner: [{ kommun_kod: '1980', kommun_namn: 'Västerås' }],
      vendors: [{ name: 'NE', slug: 'ne' }, { name: 'Magma', slug: null }],
    });
    expect(html).toContain('href="/kommun/1980"');
    expect(html).toContain('Västerås');
    expect(html).toContain('href="/leverantor/ne"'); // has a page
    expect(html).toContain('title="ingen leverantörssida än"'); // Magma: shown, not linked
    expect(html).not.toContain('href="/leverantor/magma"');
  });

  it('honest empty states for both sections', () => {
    const html = renderRamavtal({ reseller, kommuner: [], vendors: [] });
    expect(html).toContain('Inga kända kommuner');
    expect(html).toContain('Inga kända leverantörer via detta ramavtal än.');
  });
});

describe('mergeResellerRelations (pure, fill-only)', () => {
  it('fills reseller_relations and preserves every other field', () => {
    const original = JSON.stringify({
      intent: 'delivery', confidence: 0.9, summary: 's',
      extracted: { arendenummer: 'K1', mentioned_vendors: ['NE'], reseller_relations: null },
      draft_reply: 'Hej', follow_up_at: null,
    });
    const merged = mergeResellerRelations(original, [{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    const parsed = JSON.parse(merged);
    expect(parsed.extracted.reseller_relations).toEqual([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    // untouched fields
    expect(parsed.intent).toBe('delivery');
    expect(parsed.extracted.arendenummer).toBe('K1');
    expect(parsed.extracted.mentioned_vendors).toEqual(['NE']);
    expect(parsed.draft_reply).toBe('Hej');
  });

  it('is fill-only: never overwrites an already-populated reseller_relations', () => {
    const original = JSON.stringify({ extracted: { reseller_relations: [{ vendor: 'X', ramavtal: 'Adda' }] } });
    expect(mergeResellerRelations(original, [{ vendor: 'NE', ramavtal: 'Läromedia' }])).toBeNull();
  });

  it('null empty relations become null (not [])', () => {
    const original = JSON.stringify({ extracted: { reseller_relations: null, arendenummer: 'K1' } });
    const parsed = JSON.parse(mergeResellerRelations(original, []));
    expect(parsed.extracted.reseller_relations).toBeNull();
  });

  it('returns null for malformed JSON / missing extracted', () => {
    expect(mergeResellerRelations('{not json', [])).toBeNull();
    expect(mergeResellerRelations(JSON.stringify({ intent: 'x' }), [])).toBeNull();
    expect(mergeResellerRelations(null, [])).toBeNull();
  });
});

describe('parseArgs', () => {
  it('parses --dry-run, --db=, --only=', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, dbPath: null, onlyId: null });
    expect(parseArgs(['--db=/tmp/x.db', '--only=7'])).toMatchObject({ dryRun: false, dbPath: '/tmp/x.db', onlyId: 7 });
  });
});

describe('runBackfill (fill-only, injected fake LLM)', () => {
  // Fake LLM that returns the same relations for every call.
  function fakeClient(relations) {
    return {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ reseller_relations: relations }) }] })),
      },
    };
  }

  it('fills reseller_relations on inbound rows and leaves every other analysis field byte-identical', async () => {
    const analysis = {
      intent: 'delivery', confidence: 0.9, summary: 'levererar',
      extracted: { arendenummer: 'K9', mentioned_vendors: ['NE'], reseller_relations: null },
      draft_reply: 'Hej', follow_up_at: null,
    };
    const { mid } = seedInbound('1980', 'Västerås', analysis, { body: 'NE via Läromedia' });
    const before = db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(mid).analysis_json;

    const client = fakeClient([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    const summary = await runBackfill({ db, env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(summary.filled).toBe(1);

    const after = JSON.parse(db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(mid).analysis_json);
    expect(after.extracted.reseller_relations).toEqual([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    // Everything else byte-identical to the pre-run blob.
    const beforeObj = JSON.parse(before);
    const afterCopy = { ...after, extracted: { ...after.extracted } };
    delete afterCopy.extracted.reseller_relations;
    const beforeCopy = { ...beforeObj, extracted: { ...beforeObj.extracted } };
    delete beforeCopy.extracted.reseller_relations;
    expect(afterCopy).toEqual(beforeCopy);
  });

  it('--dry-run makes no writes', async () => {
    const { mid } = seedInbound('1980', 'Västerås', { extracted: { reseller_relations: null } });
    const before = db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(mid).analysis_json;
    const client = fakeClient([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    const summary = await runBackfill({ db, env: { ANTHROPIC_API_KEY: 'k' }, client, dryRun: true });
    expect(summary.filled).toBe(1);
    const after = db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(mid).analysis_json;
    expect(after).toBe(before); // unchanged
  });

  it('does not touch non-inbound rows', async () => {
    const cid = db.createConversation({ kommun_kod: '1980', kommun_namn: 'V', role: 'central', contact_email: 'r@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    const outMid = db.recordMessage({
      conversation_id: cid, gmail_message_id: 'out1', direction: 'outbound',
      from_email: 'g@m.se', to_email: 'r@x.se', subject: 's', body_text: 'b',
      classification: null, classification_confidence: null,
      received_at: '2026-05-19T10:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { reseller_relations: null } }),
    });
    const before = db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(outMid).analysis_json;
    const client = fakeClient([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    await runBackfill({ db, env: { ANTHROPIC_API_KEY: 'k' }, client });
    const after = db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(outMid).analysis_json;
    expect(after).toBe(before);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('--only=<id> processes a single message', async () => {
    const a = seedInbound('1980', 'V', { extracted: { reseller_relations: null } }, { gid: 'a', body: 'x', role: 'central' });
    const b = seedInbound('1980', 'V', { extracted: { reseller_relations: null } }, { gid: 'b', body: 'y', role: 'utbildning' });
    const client = fakeClient([{ vendor: 'NE', ramavtal: 'Läromedia' }]);
    const summary = await runBackfill({ db, env: { ANTHROPIC_API_KEY: 'k' }, client, onlyId: a.mid });
    expect(summary.scanned).toBe(1);
    expect(summary.filled).toBe(1);
    // b untouched
    const bAfter = JSON.parse(db.raw.prepare('SELECT analysis_json FROM messages WHERE id = ?').get(b.mid).analysis_json);
    expect(bAfter.extracted.reseller_relations).toBeNull();
  });
});
