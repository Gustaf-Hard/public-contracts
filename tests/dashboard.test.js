import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp, buildActionQueue, buildWaiting, applyFilter, buildOverviewRows } from '../src/dashboard.js';
import { layout } from '../src/dashboard-views.js';

let tmp, db, dbPath, muniPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dash-'));
  dbPath = join(tmp, 'pilot.db');
  muniPath = join(tmp, 'municipalities.json');

  // Minimal municipalities dataset: 3 kommuner
  writeFileSync(muniPath, JSON.stringify([
    { kommun_kod: '2418', kommun_namn: 'Malå', lan: 'Västerbottens län', folkmangd: 2902, contacts: [
      { role: 'central', email: 'kommun@mala.se' },
      { role: 'utbildning', email: 'bun@mala.se' },
    ]},
    { kommun_kod: '0560', kommun_namn: 'Boxholm', lan: 'Östergötlands län', folkmangd: 5451, contacts: [] },
    { kommun_kod: '9999', kommun_namn: 'Testkommun', lan: 'Testlän', folkmangd: 0, contacts: [] },
  ]));

  db = openDb(dbPath);
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function appWithFakes() {
  return createDashboardApp({
    db,
    municipalitiesLoader: () => JSON.parse(require('node:fs').readFileSync(muniPath, 'utf8')),
  });
}

// Use a tiny request helper since we don't pull in supertest
async function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text }));
      }).catch((e) => {
        server.close(() => reject(e));
      });
    });
  });
}

describe('dashboard / overview', () => {
  it('shows all kommuner with "ej kontaktad" under ?filter=all', async () => {
    const app = appWithFakes();
    // Home now defaults to active kommuner; the full 290-list is behind ?filter=all
    const res = await get(app, '/?filter=all');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Malå');
    expect(res.text).toContain('Boxholm');
    expect(res.text).toContain('Testkommun');
    expect(res.text).toContain('ej kontaktad');
  });

  it('default home hides never-contacted kommuner and shows the queue heading', async () => {
    const app = appWithFakes();
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Behöver dig');
    expect(res.text).not.toContain('Boxholm'); // never contacted → not in the active default
  });

  it('shows pilot state when a conversation exists', async () => {
    db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'utbildning',
      contact_email: 'bun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    const app = appWithFakes();
    const res = await get(app, '/');
    expect(res.text).toContain('Malå');
    expect(res.text).toMatch(/Schemalagt|INITIAL/);
  });

  it('filters by ?filter=in-pilot', async () => {
    db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    const app = appWithFakes();
    const res = await get(app, '/?filter=in-pilot');
    expect(res.text).toContain('Malå');
    expect(res.text).not.toContain('Boxholm'); // Boxholm has no conversation
  });
});

describe('dashboard / kommun detail', () => {
  it('renders kommun details and conversation messages', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'utbildning',
      contact_email: 'bun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.updateConversationState(cid, 'SENT', { gmail_thread_id: 't1', last_outbound_at: '2026-05-24T10:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'm1', direction: 'inbound',
      from_email: 'mikaela@example.se', to_email: 'gustaf@mediagraf.se',
      subject: 'Re: Begäran', body_text: 'Med vänlig hälsning\nMikaela Radgren\nEnhetschef',
      classification: 'auto_ack', classification_confidence: 0.85,
      received_at: '2026-05-24T11:00:00Z', attachment_count: 0,
      signature_extracted: { name: 'Mikaela Radgren', title: 'Enhetschef' },
    });
    const app = appWithFakes();
    const res = await get(app, '/kommun/2418');
    expect(res.text).toContain('Malå');
    expect(res.text).toContain('Mikaela Radgren');
    expect(res.text).toContain('Enhetschef');
    expect(res.text).toContain('auto_ack');
  });

  it('404-style fallback for unknown kommun_kod', async () => {
    const app = appWithFakes();
    const res = await get(app, '/kommun/0001');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Hittade inte');
  });
});

describe('dashboard / escalations', () => {
  it('lists open escalations across kommuner', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.recordEscalation({
      conversation_id: cid, reason: 'classifier=unknown',
      draft_template: 'free_form', draft_body: '(ingen draft)',
    });
    const app = appWithFakes();
    const res = await get(app, '/escalations');
    expect(res.text).toContain('Malå');
    expect(res.text).toContain('free_form');
    // The card now embeds an editable form pointing at the action endpoint
    expect(res.text).toContain(`action="/escalations/`);
    expect(res.text).toContain('Skicka');
    expect(res.text).toContain('Hoppa över');
  });

  it('shows the empty state when there are no open escalations', async () => {
    const app = appWithFakes();
    const res = await get(app, '/escalations');
    expect(res.text).toMatch(/Inga öppna eskaleringar/);
  });
});

async function getRaw(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text, headers: r.headers }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

function seedPdfAttachment({ filename = 'Avtal X.pdf', savedPath = null } = {}) {
  const convId = db.createConversation({
    kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
    contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
    from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null,
    received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const contractsDir = join(tmp, 'contracts');
  const realPath = savedPath ?? join(contractsDir, '2418', filename);
  mkdirSync(dirname(realPath), { recursive: true });
  writeFileSync(realPath, '%PDF-1.4 test');
  const attId = db.recordAttachment({
    message_id: msgId, filename, saved_path: realPath,
    mime_type: 'application/pdf', size_bytes: 13,
  });
  return { convId, attId, contractsDir };
}

describe('GET /attachments/:id', () => {
  it('serves the PDF inline with correct headers', async () => {
    const { attId, contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir });
    const res = await getRaw(app, `/attachments/${attId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.text).toContain('%PDF-1.4');
  });

  it('404 on unknown id', async () => {
    const { contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir });
    expect((await getRaw(app, '/attachments/99999')).status).toBe(404);
  });

  it('404 when saved_path escapes contractsDir', async () => {
    const outside = join(tmp, 'secret.pdf');
    const { attId } = seedPdfAttachment({ savedPath: outside });
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir: join(tmp, 'contracts') });
    expect((await getRaw(app, `/attachments/${attId}`)).status).toBe(404);
  });
});

describe('clickable contract links on kommun page', () => {
  it('Mottagna avtal table and timeline link to /attachments/:id', async () => {
    const { attId, contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({
      db, contractsDir,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }],
    });
    const res = await get(app, '/kommun/2418');
    const matches = res.text.match(new RegExp(`href="/attachments/${attId}"`, 'g'));
    expect(matches?.length).toBeGreaterThanOrEqual(2); // table + timeline
  });
});

function seedVendorWithContract() {
  const { attId } = seedPdfAttachment();
  const v = db.upsertVendor('Skolon');
  const cId = db.recordContract({
    attachment_id: attId, vendor_id: v.id,
    avtalsvarde: '120 000 kr/år', valuta: 'SEK',
    period_start: '2025-08-01', period_end: '2027-07-31',
    is_contract: 1, summary: 'Lärplattform', confidence: 0.95,
  });
  db.linkContractProduct(cId, db.upsertProduct(v.id, 'Skolon Plattform'));
  return { v, attId };
}

describe('vendor pages', () => {
  it('/leverantorer lists vendors with counts and links', async () => {
    seedVendorWithContract();
    const app = appWithFakes();
    const res = await get(app, '/leverantorer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Skolon');
    expect(res.text).toContain('href="/leverantor/skolon"');
    expect(res.text).toContain('Skolon Plattform');
  });

  it('/leverantor/:slug shows contracts with PDF links and kommun', async () => {
    const { attId } = seedVendorWithContract();
    const app = appWithFakes();
    const res = await get(app, '/leverantor/skolon');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Malå');
    expect(res.text).toContain(`href="/attachments/${attId}"`);
    expect(res.text).toContain('2027-07-31');
  });

  it('unknown slug → 404', async () => {
    const app = appWithFakes();
    expect((await get(app, '/leverantor/nope')).status).toBe(404);
  });

  it('nav contains Leverantörer link', async () => {
    const app = appWithFakes();
    const res = await get(app, '/');
    expect(res.text).toContain('href="/leverantorer"');
  });
});

describe('kommun vendor tags link to vendor pages', () => {
  it('vendor tags link to vendor page when name matches', async () => {
    seedVendorWithContract();
    const conv = db.raw.prepare("SELECT * FROM conversations WHERE kommun_kod = '2418'").get();
    db.recordMessage({
      conversation_id: conv.id, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'a@b.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Avtal med Skolon bifogas',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'delivery', extracted: { mentioned_vendors: ['Skolon'] } },
    });
    const app = createDashboardApp({
      db,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }],
    });
    const res = await get(app, '/kommun/2418');
    expect(res.text).toContain('href="/leverantor/skolon"');
  });
});

describe('kommun page contact sources', () => {
  it('shows handoff address with source badge, ranked above website contact', async () => {
    const convId = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta BoU',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: 'bou@mala.se', handoff_to_forvaltning: 'BoU' } },
    });
    const app = createDashboardApp({
      db,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1,
        contacts: [{ email: 'kommun@mala.se', role: 'central' }] }],
    });
    const res = await get(app, '/kommun/2418');
    expect(res.text).toContain('bou@mala.se');
    expect(res.text).toContain('kommunen angav i mejl');
    expect(res.text).toContain('hittad på webbplats');
    expect(res.text.indexOf('bou@mala.se')).toBeLessThan(res.text.indexOf('kommun@mala.se'));
  });
});

describe('compose candidates prefer handoff addresses', () => {
  it('lists the handoff address first for the selected role', async () => {
    const convId = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'gymnasie',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta central',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: 'registrator@mala.se', handoff_to_forvaltning: 'Kommunkansliet' } },
    });
    const app = createDashboardApp({
      db,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1,
        contacts: [{ email: 'central@mala.se', role: 'central' }] }],
    });
    const res = await get(app, '/kommun/2418/compose?role=central');
    expect(res.text).toContain('registrator@mala.se');
    expect(res.text.indexOf('registrator@mala.se')).toBeLessThan(res.text.indexOf('central@mala.se'));
  });
});

describe('app shell', () => {
  it('full layout has a sidebar nav, theme bootstrap, app.js, no meta-refresh', () => {
    const html = layout({ title: 'X', body: '<p>hi</p>', currentPath: '/' });
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('href="/arenden"');
    expect(html).toContain('id="content"');
    expect(html).toContain('/app.js');
    expect(html).toContain("localStorage.getItem('pilot-theme')");
    expect(html).not.toMatch(/http-equiv="refresh"/);
  });

  it('partial layout returns only the inner body fragment', () => {
    const html = layout({ title: 'X', body: '<p>hi</p>', currentPath: '/', partial: true });
    expect(html).toBe('<p>hi</p>');
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('class="sidebar"');
  });
});

describe('partial responses', () => {
  it('GET /?partial=1 returns a fragment, not a full document', async () => {
    const res = await get(appWithFakes(), '/?partial=1');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<!doctype/i);
    expect(res.text).not.toContain('class="sidebar"');
  });
  it('GET / (no partial) returns the full shell', async () => {
    const res = await get(appWithFakes(), '/');
    expect(res.text).toContain('class="sidebar"');
  });
  it('serves /app.js', async () => {
    const res = await get(appWithFakes(), '/app.js');
    expect(res.status).toBe(200);
  });
});

describe('home buckets', () => {
  it('buildActionQueue surfaces a conversation with an open escalation', () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se',
      scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.recordEscalation({ conversation_id: cid, reason: 'handoff', draft_template: 'free_form', draft_subject: 'Re', draft_body: 'b' });
    const q = buildActionQueue(db);
    expect(q.some((x) => x.conv_id === cid && x.kommun_kod === '2418')).toBe(true);
  });

  it('buildWaiting surfaces an open SENT case but not one with an open escalation', () => {
    const waitingId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z' });
    db.updateConversationState(waitingId, 'SENT', { last_outbound_at: '2026-05-24T10:00:00Z' });
    const escId = db.createConversation({ kommun_kod: '0560', kommun_namn: 'Boxholm', role: 'central', contact_email: 'k@box.se', scheduled_send_at: '2026-05-24T10:00:00Z' });
    db.updateConversationState(escId, 'SENT', {});
    db.recordEscalation({ conversation_id: escId, reason: 'x', draft_template: 'free_form', draft_body: 'b' });
    const w = buildWaiting(db);
    expect(w.some((x) => x.conv_id === waitingId)).toBe(true);
    expect(w.some((x) => x.conv_id === escId)).toBe(false); // in the action queue instead
  });

  it("applyFilter('active') drops never-contacted kommuner", () => {
    db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z' });
    const munis = JSON.parse(require('node:fs').readFileSync(muniPath, 'utf8'));
    const rows = buildOverviewRows(munis, db);
    const active = applyFilter(rows, 'active');
    expect(active.every((r) => r.states.length > 0)).toBe(true);
    expect(active.some((r) => r.kommun_kod === '2418')).toBe(true);
    expect(active.some((r) => r.kommun_kod === '0560')).toBe(false);
  });
});
