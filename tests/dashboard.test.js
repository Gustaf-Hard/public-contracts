import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp, buildActionQueue, buildWaiting, applyFilter, buildOverviewRows, contentDisposition } from '../src/dashboard.js';
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

// Like get(), but does not follow redirects — returns status + Location.
async function getNoRedirect(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' }).then(async (r) => {
        server.close(() => resolve({ status: r.status, location: r.headers.get('location') }));
      }).catch((e) => server.close(() => reject(e)));
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
    // The kommun page now renders the same Gmail-style thread as /arenden:
    // thread markup is present, and raw classifier labels (auto_ack) are not
    // surfaced here any more — consistency with the Ärenden tab.
    expect(res.text).toContain('thread-msgs');
    expect(res.text).not.toContain('auto_ack');
  });

  it('404-style fallback for unknown kommun_kod', async () => {
    const app = appWithFakes();
    const res = await get(app, '/kommun/0001');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Hittade inte');
  });

  it('reply form shows an editable Till: field prefilled with the thread counterparty', async () => {
    const convId = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'registrator@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z',
    });
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-h', counterparty_email: 'handlaggare@mala.se' });
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-1', direction: 'inbound',
      from_email: 'handlaggare@mala.se', to_email: 'me@x.se', subject: 'SV', body_text: 'x',
      classification: 'precision', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z',
      attachment_count: 0, gmail_thread_id: 'thr-h', thread_id: t.id,
    });
    db.recordEscalation({ conversation_id: convId, message_id: mid, reason: 'r', draft_template: 'T_PRECISION', draft_subject: 'Re: SV', draft_body: 'svar' });

    const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }] });
    const res = await get(app, '/kommun/2418');
    expect(res.text).toMatch(/name="to"[^>]*value="handlaggare@mala\.se"/);
  });
});

describe('dashboard / arenden (master-detail)', () => {
  it('GET /escalations redirects into the Ärenden behöver-dig bucket', async () => {
    const res = await getNoRedirect(appWithFakes(), '/escalations');
    expect(res.status).toBe(302);
    expect(res.location).toContain('/arenden');
  });

  it('GET /arenden lists cases grouped by bucket', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.recordEscalation({ conversation_id: cid, reason: 'classifier=unknown', draft_template: 'free_form', draft_body: '(ingen draft)' });
    const res = await get(appWithFakes(), '/arenden');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="master-detail"');
    expect(res.text).toContain('Malå');
    expect(res.text).toContain('Behöver dig');
  });

  it('GET /arenden/:id renders the case detail with the escalation form and a collapsed timeline', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.updateConversationState(cid, 'SENT', { last_outbound_at: '2026-05-24T10:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'm1', direction: 'inbound',
      from_email: 'k@mala.se', to_email: 'me@x.com', subject: 'Re: Begäran',
      body_text: 'Hej, vi återkommer.', classification: 'delay_promise', classification_confidence: 0.8,
      received_at: '2026-05-24T11:00:00Z', attachment_count: 0,
    });
    db.recordEscalation({ conversation_id: cid, reason: 'classifier=unknown', draft_template: 'free_form', draft_subject: 'Re: Begäran', draft_body: '(ingen draft)' });
    const res = await get(appWithFakes(), `/arenden/${cid}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-collapse-target');     // timeline body collapsed
    expect(res.text).toContain('action="/escalations/');    // send form present
    expect(res.text).toContain('Skicka');
    expect(res.text).toContain('Hoppa över');
  });

  it('GET /arenden shows an empty state when there are no cases', async () => {
    const res = await get(appWithFakes(), '/arenden');
    expect(res.text).toMatch(/Inga ärenden ännu/);
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

async function postForm(app, path, fields) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text, location: r.headers.get('location') }));
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

describe('contentDisposition', () => {
  it('emits an ASCII fallback plus an RFC 5987 utf-8 name, with no chars >255', () => {
    const cd = contentDisposition('Avtal inläsningstjänst – ILT.pdf');
    expect([...cd].every((c) => c.charCodeAt(0) <= 255)).toBe(true);
    expect(cd).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
  });

  it('strips path separators and double-quotes from the ascii fallback', () => {
    const cd = contentDisposition('a/b\\c"d.pdf');
    const ascii = cd.match(/filename="([^"]*)"/)[1];
    expect(ascii).not.toMatch(/["/\\]/);
  });
});

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

  it('serves a filename with decomposed (NFD) Swedish chars without an invalid-header crash', async () => {
    // macOS/Gmail filenames are often NFD: "ä" = "a" + U+0308 (combining
    // diaeresis, code point 776 > 255), which node rejects in a header.
    const nfd = 'Avtal inläsningstjänst - ILT education.pdf';
    const { attId, contractsDir } = seedPdfAttachment({ filename: nfd });
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir });
    const res = await getRaw(app, `/attachments/${attId}`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toContain('inline');
    expect(cd).toContain("filename*=UTF-8''"); // RFC 5987 unicode name present
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
  it('/leverantorer lists vendors with counts and links in a master-detail view', async () => {
    seedVendorWithContract();
    const app = appWithFakes();
    const res = await get(app, '/leverantorer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="master-detail"');
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

describe('polish', () => {
  it('case detail uses an intent badge, not a raw intent/action debug string', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.recordEscalation({ conversation_id: cid, reason: 'intent=handoff action=escalate confidence=0.92', draft_template: 'free_form', classifier_class: 'handoff', draft_body: 'b' });
    const res = await get(appWithFakes(), `/arenden/${cid}`);
    expect(res.text).not.toMatch(/intent=\w+ action=/); // no debug string in the UI
    expect(res.text).toContain('class="badge"');         // a real badge instead
  });

  it('activity feed shows a designed empty state when there is nothing', async () => {
    const res = await get(appWithFakes(), '/activity');
    expect(res.text).toMatch(/Ingen aktivitet ännu/);
  });
});

describe('arenden gmail look', () => {
  it('list uses Gmail-style mail rows; detail is a thread with a reply box', async () => {
    const cid = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-05-24T10:00:00Z',
    });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'o1', direction: 'outbound',
      from_email: 'me@x.com', to_email: 'kommun@mala.se', subject: 'Begäran om allmänna handlingar',
      body_text: 'Hej, vi begär...', classification: null, classification_confidence: null,
      received_at: '2026-05-24T10:00:00Z', attachment_count: 0,
    });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'i1', direction: 'inbound',
      from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Re: Begäran',
      body_text: 'Hej, vi återkommer.', classification: 'delay_promise', classification_confidence: 0.8,
      received_at: '2026-05-26T09:00:00Z', attachment_count: 0,
    });
    db.recordEscalation({ conversation_id: cid, reason: 'x', draft_template: 'free_form', draft_subject: 'Re: Begäran', draft_body: 'utkast' });
    const list = await get(appWithFakes(), '/arenden');
    expect(list.text).toContain('class="mail-row');     // Gmail inbox rows
    const detail = await get(appWithFakes(), `/arenden/${cid}`);
    expect(detail.text).toContain('class="thread"');     // Gmail thread
    expect(detail.text).toContain('class="msg ');        // stacked message blocks
    expect(detail.text).toContain('class="reply-box"');  // suggested reply box
    expect(detail.text).toContain('kommun@mala.se');     // sender address shown
  });
});

describe('health modal', () => {
  it('shows the health modal + reauth button when there is no successful tick', async () => {
    const res = await get(appWithFakes(), '/');
    expect(res.text).toContain('data-health-modal');
    expect(res.text).toContain('Återanslut Gmail');
  });

  it('hides the modal once a successful tick is recorded', async () => {
    db.recordHeartbeat({ kind: 'tick', error: null });
    const res = await get(appWithFakes(), '/');
    expect(res.text).not.toContain('data-health-modal');
  });

  it('flags invalid_grant cause in the modal', async () => {
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    const res = await get(appWithFakes(), '/');
    expect(res.text).toContain('data-health-modal');
    expect(res.text).toContain('invalid_grant');
  });

  it('GET /api/health reports stale state', async () => {
    const res = await get(appWithFakes(), '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).stale).toBe(true);
  });
});

describe('thread-grouped case view', () => {
  it('groups the case view by thread with a status chip and a toggle form', async () => {
    const convId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
    const tA = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-anneli', counterparty_email: 'Anneli.Waern@arboga.se', counterparty_name: 'Anneli Waern' });
    db.setThreadStatus(tA.id, 'primary', 'auto');
    const tR = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-reg', counterparty_email: 'arboga.kommun@arboga.se', counterparty_name: 'Arboga kommun' });
    db.setThreadStatus(tR.id, 'muted', 'auto');
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'ann-1', direction: 'inbound', from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z', attachment_count: 10, gmail_thread_id: 'thr-anneli', thread_id: tA.id });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'reg-1', direction: 'inbound', from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.se', subject: 'ack', body_text: 'mottaget', classification: 'auto_ack', classification_confidence: 0.9, received_at: '2026-06-08T00:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-reg', thread_id: tR.id });

    const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Arboga', lan: 'X', folkmangd: 1, contacts: [] }] });
    const res = await get(app, '/kommun/2418');
    expect(res.text).toContain('Anneli Waern');
    expect(res.text).toContain('Arboga kommun');
    expect(res.text).toMatch(/action="\/threads\/\d+\/status"/); // toggle present
    expect(res.text).toMatch(/primary/); // status chip label
    expect(res.text).toMatch(/muted/);
  });

  it('renders Ogrupperat section for messages with null thread_id', async () => {
    const kommun_kod = '2418';
    const convId = db.createConversation({ kommun_kod, kommun_namn: 'Malå', role: 'central', contact_email: 'registrator@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-known' });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-known', counterparty_email: 'known@x.se', counterparty_name: 'Known Person' });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'k-1', direction: 'inbound', from_email: 'known@x.se', to_email: 'me@x.se', subject: 'SV', body_text: 'known-message-body', classification: 'auto_ack', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-known', thread_id: t.id });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'orp-1', direction: 'inbound', from_email: 'anon@x.se', to_email: 'me@x.se', subject: 'Utan tråd', body_text: 'orphan-message-body', classification: null, classification_confidence: null, received_at: '2026-05-28T00:00:00Z', attachment_count: 0, gmail_thread_id: null, thread_id: null });

    const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod, kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }] });
    const res = await get(app, `/kommun/${kommun_kod}`);
    expect(res.text).toContain('Ogrupperat');
    expect(res.text).toContain('orphan-message-body');
  });

  it('keeps an open escalation visible even when its thread is muted', async () => {
    // A thread can be muted manually AFTER an escalation was already opened on
    // it (ingest-time muting skips escalation creation, so a pending escalation
    // predates the mute). That open escalation is a real action and must stay
    // visible — muting suppresses NEW suggestions, not existing ones.
    const kommun_kod = '2418';
    const convId = db.createConversation({ kommun_kod, kommun_namn: 'Malå', role: 'central', contact_email: 'registrator@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-m' });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-m', counterparty_email: 'handlaggare@mala.se', counterparty_name: 'Handläggare' });
    const mid = db.recordMessage({ conversation_id: convId, gmail_message_id: 'm-1', direction: 'inbound', from_email: 'handlaggare@mala.se', to_email: 'me@x.se', subject: 'SV', body_text: 'fråga', classification: 'clarification', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-m', thread_id: t.id });
    db.recordEscalation({ conversation_id: convId, message_id: mid, reason: 'r', draft_template: 'T_PRECISION', draft_subject: 'Re: SV', draft_body: 'utkast-svar-som-vantar' });
    db.setThreadStatus(t.id, 'muted', 'manual'); // operator mutes AFTER the escalation exists

    const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod, kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }] });
    const res = await get(app, `/kommun/${kommun_kod}`);
    expect(res.text).toMatch(/action="\/escalations\/\d+"/); // reply form still rendered
    expect(res.text).toContain('utkast-svar-som-vantar'); // its draft body is visible
  });
});

describe('thread status toggle', () => {
  it('POST /threads/:id/status sets a manual status', async () => {
    const convId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a' });
    const app = createDashboardApp({ db, municipalitiesLoader: () => [] });
    const res = await postForm(app, `/threads/${t.id}/status`, { status: 'muted', return: '/arenden' });
    expect([302, 303]).toContain(res.status);
    expect(db.getThreadById(t.id).status).toBe('muted');
    expect(db.getThreadById(t.id).status_source).toBe('manual');
  });
});
