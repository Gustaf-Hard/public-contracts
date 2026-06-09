import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';

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
  it('shows all kommuner with "ej kontaktad" when no pilot data exists', async () => {
    const app = appWithFakes();
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Malå');
    expect(res.text).toContain('Boxholm');
    expect(res.text).toContain('Testkommun');
    expect(res.text).toContain('ej kontaktad');
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
