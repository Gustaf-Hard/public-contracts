// Durable handoff lifecycle (2026-09-06 design): a kommun's "contact X
// instead" becomes a handoff_tasks row that cannot be lost by a missed click.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hot-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedConv({ kod = '1460', name = 'Bengtsfors', role = 'central', email = 'kommun@bengtsfors.se' } = {}) {
  return db.createConversation({
    kommun_kod: kod, kommun_namn: name, role, contact_email: email,
    scheduled_send_at: '2026-08-01T08:00:00Z',
  });
}

function seedHandoffMessage(convId, { email = 'helen.pettersson@amal.se' } = {}) {
  return db.recordMessage({
    conversation_id: convId, gmail_message_id: `ho-${convId}-${email}`, direction: 'inbound',
    from_email: 'registrator@bengtsfors.se', to_email: 'x', subject: 'Sv: begäran',
    body_text: `Kontakta ${email} för avtalen.`, received_at: '2026-08-14T07:53:00Z',
    attachment_count: 0,
    analysis_json: JSON.stringify({ intent: 'handoff', extracted: { handoff_to_email: email } }),
  });
}

const task = (convId, msgId, over = {}) => ({
  kommun_kod: '1460', address: 'Helen.Pettersson@amal.se', forvaltning: 'IT-enheten i Åmål',
  role: 'other', source_conversation_id: convId, source_message_id: msgId,
  verbatim: 1, same_domain: 0, ...over,
});

describe('backfill from existing handoff mail', () => {
  it('migrate creates pending tasks for unactioned handoffs, started for addressed ones, idempotently', () => {
    const c1 = seedConv();
    seedHandoffMessage(c1);                                   // unactioned → pending
    const c2 = seedConv({ kod: '1480', name: 'Göteborg', email: 'stadsledning@goteborg.se' });
    db.recordMessage({
      conversation_id: c2, gmail_message_id: 'ho-gbg', direction: 'inbound',
      from_email: 'stadsledning@goteborg.se', to_email: 'x', subject: 'Sv',
      body_text: 'Kontakta grundskola@goteborg.se.', received_at: '2026-08-20T08:00:00Z',
      attachment_count: 0,
      analysis_json: JSON.stringify({ intent: 'handoff', extracted: { handoff_to_email: 'grundskola@goteborg.se' } }),
    });
    seedConv({ kod: '1480', name: 'Göteborg', role: 'utbildning', email: 'grundskola@goteborg.se' }); // already started
    db.migrate();                                             // backfill pass
    db.migrate();                                             // idempotent
    const pending = db.listPendingHandoffTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].address).toBe('helen.pettersson@amal.se');
    const gbg = db.listHandoffTasksForConversation(c2);
    expect(gbg).toHaveLength(1);
    expect(gbg[0].status).toBe('started');
  });
});

describe('handoff_tasks storage', () => {
  it('upsert creates a pending task with a lowercased address', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    const t = db.upsertHandoffTask(task(c, m));
    expect(t.status).toBe('pending');
    const rows = db.listPendingHandoffTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('helen.pettersson@amal.se');
    expect(rows[0].source_conversation_id).toBe(c);
  });

  it('at most one pending per (kommun, address): a repeat upsert returns the existing task', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    const a = db.upsertHandoffTask(task(c, m));
    const b = db.upsertHandoffTask(task(c, m));
    expect(b.id).toBe(a.id);
    expect(db.listPendingHandoffTasks()).toHaveLength(1);
  });

  it('an address that already has a conversation births the task started, never pending', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    const other = seedConv({ role: 'utbildning', email: 'helen.pettersson@amal.se' });
    const t = db.upsertHandoffTask(task(c, m, { started_conv_id: other }));
    expect(t.status).toBe('started');
    expect(db.listPendingHandoffTasks()).toHaveLength(0);
    expect(db.listHandoffTasksForConversation(c)[0].started_conv_id).toBe(other);
  });

  it('a newer handoff from the same source conversation supersedes its other pending tasks', () => {
    const c = seedConv(); const m1 = seedHandoffMessage(c);
    db.upsertHandoffTask(task(c, m1));
    const m2 = seedHandoffMessage(c, { email: 'ny.adress@amal.se' });
    db.upsertHandoffTask(task(c, m2, { address: 'ny.adress@amal.se' }));
    const all = db.listHandoffTasksForConversation(c);
    expect(all.find((t) => t.address === 'helen.pettersson@amal.se').status).toBe('superseded');
    expect(all.find((t) => t.address === 'ny.adress@amal.se').status).toBe('pending');
    expect(db.listPendingHandoffTasks()).toHaveLength(1);
  });

  it('startHandoffTasksForAddress flips pending→started and stamps resolved_at', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    db.upsertHandoffTask(task(c, m));
    const target = seedConv({ role: 'other', email: 'helen.pettersson@amal.se' });
    const n = db.startHandoffTasksForAddress('1460', 'HELEN.pettersson@amal.se', target);
    expect(n).toBe(1);
    const row = db.listHandoffTasksForConversation(c)[0];
    expect(row.status).toBe('started');
    expect(row.started_conv_id).toBe(target);
    expect(row.resolved_at).toBeTruthy();
  });

  it('dismiss requires a reason and records it', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    const t = db.upsertHandoffTask(task(c, m));
    expect(() => db.dismissHandoffTask(t.id, '')).toThrow(/reason/i);
    db.dismissHandoffTask(t.id, 'delad IT-enhet, redan täckt av annat ärende');
    const row = db.listHandoffTasksForConversation(c)[0];
    expect(row.status).toBe('dismissed');
    expect(row.dismissed_reason).toMatch(/delad IT-enhet/);
    expect(db.listPendingHandoffTasks()).toHaveLength(0);
  });

  it('naggable respects the 2-day age and 3-day renag windows; marking stamps only named ids', () => {
    const c = seedConv(); const m = seedHandoffMessage(c);
    const t = db.upsertHandoffTask(task(c, m));
    const now = new Date('2026-09-11T09:00:00Z');
    // created_at is "now" (fresh) → not naggable yet
    expect(db.listNaggableHandoffTasks({ now })).toHaveLength(0);
    db.raw.prepare('UPDATE handoff_tasks SET created_at = ? WHERE id = ?')
      .run('2026-09-05 08:00:00', t.id);
    expect(db.listNaggableHandoffTasks({ now })).toHaveLength(1);
    db.markHandoffTasksNagged([t.id], now);
    expect(db.listNaggableHandoffTasks({ now })).toHaveLength(0);          // just nagged
    const later = new Date('2026-09-15T09:00:00Z');                        // > 3 days on
    expect(db.listNaggableHandoffTasks({ now: later })).toHaveLength(1);
  });
});
