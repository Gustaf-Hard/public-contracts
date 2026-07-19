// Offline retag helper (2026-07-19 §5): converts existing open mailer-daemon /
// NDR free-form escalations to the bounce shape so the resend form shows.
// Temp DB only — never touches the live pilot.db, never runs the CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { retagBounceEscalations, parseArgs } from '../scripts/11-retag-bounce-escalations.js';

const env = { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me' };

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'retag-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seedBounceEscalation() {
  const convId = db.createConversation({
    kommun_kod: '1281', kommun_namn: 'Lund', role: 'central',
    contact_email: 'lund.kommun@lund.se', scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'NEEDS_HUMAN', { gmail_thread_id: 'thr-b' });
  const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-b', counterparty_email: 'mailer-daemon@googlemail.com' });
  const mid = db.recordMessage({
    conversation_id: convId, gmail_message_id: 'ndr-1', direction: 'inbound',
    from_email: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    to_email: 'me@x.se', subject: 'Delivery Status Notification (Failure)',
    body_text: "** Address not found **\n\nYour message wasn't delivered to lund.kommun@lund.se because the address couldn't be found.",
    classification: 'unknown', classification_confidence: 0.5,
    received_at: '2026-07-05T00:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-b', thread_id: t.id,
  });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: mid, reason: 'behöver dig',
    draft_template: 'free_form', draft_subject: 'Re: Begäran', draft_body: '(ingen draft)',
    classifier_class: null,
  });
  return { convId, escId };
}

describe('retagBounceEscalations', () => {
  it('retags an open free-form mailer-daemon escalation into the bounce shape', () => {
    const { escId } = seedBounceEscalation();
    const actions = retagBounceEscalations(db, { env });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ escalation_id: escId, dead_address: 'lund.kommun@lund.se' });

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    expect(esc.classifier_class).toBe('bounce');
    expect(esc.draft_template).toBe('T_RESEND_BAD_ADDRESS');
    expect(esc.reason).toMatch(/lund\.kommun@lund\.se/);
    expect(esc.draft_subject).toMatch(/Begäran om allmänna handlingar/);
    expect(esc.draft_body).toMatch(/offentlighetsprincipen/);
    expect(esc.status).toBe('open'); // still open — the operator resends
  });

  it('dry-run reports the action without writing', () => {
    const { escId } = seedBounceEscalation();
    const actions = retagBounceEscalations(db, { env, dryRun: true });
    expect(actions).toHaveLength(1);
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    expect(esc.classifier_class).toBeNull();
    expect(esc.draft_template).toBe('free_form');
  });

  it('leaves a genuine (non-bounce) open escalation untouched', () => {
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'Ale', role: 'central',
      contact_email: 'k@ale.se', scheduled_send_at: '2026-07-01T00:00:00Z',
    });
    db.updateConversationState(convId, 'NEEDS_HUMAN', {});
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'ok-1', direction: 'inbound',
      from_email: 'k@ale.se', to_email: 'me@x.se', subject: 'SV', body_text: 'Här kommer avtalen.',
      classification: 'delivery', classification_confidence: 0.9, received_at: '2026-07-05T00:00:00Z', attachment_count: 1,
    });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: mid, reason: 'r',
      draft_template: 'free_form', draft_subject: 'Re: SV', draft_body: 'tack',
    });
    const actions = retagBounceEscalations(db, { env });
    expect(actions).toHaveLength(0);
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    expect(esc.draft_template).toBe('free_form');
    expect(esc.classifier_class).toBeNull();
  });

  it('is idempotent — a second run retags nothing', () => {
    seedBounceEscalation();
    expect(retagBounceEscalations(db, { env })).toHaveLength(1);
    expect(retagBounceEscalations(db, { env })).toHaveLength(0);
  });
});

describe('parseArgs', () => {
  it('parses --db and --dry-run', () => {
    expect(parseArgs(['--db=x.db', '--dry-run'])).toEqual({ db: 'x.db', dryRun: true });
  });
  it('defaults to data/pilot.db, no dry-run', () => {
    expect(parseArgs([])).toEqual({ db: 'data/pilot.db', dryRun: false });
  });
});
