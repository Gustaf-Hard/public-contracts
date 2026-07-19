// tests/kommun-vendor-panel.test.js
// Pure-view tests for the VERTICAL Leverantörer panel (2026-07-19
// vendor↔ramavtal design). Each vendor is a row: icon + name (linked to its
// page when a slug is known, else muted unlinked), plus a framed ▢ ramavtal
// pill per EXTRACTED vendor→ramavtal relation. The old "🛒 Köper via ramavtal"
// summary line is gone. No DB, no IO — renderKommunDetail takes all data via
// params.
import { describe, it, expect } from 'vitest';
import { renderKommunDetail } from '../src/dashboard-views.js';

const kommun = { kommun_kod: '1980', kommun_namn: 'Västerås', lan: 'Västmanland', folkmangd: 1, contacts: [] };

// One DONE conversation with two inbound messages: one mentions channels
// (Skolon, Läromedia) AND real product vendors (NE, Magma) in prose, one
// carries a CONFIRMED Skolon contract attachment.
function baseArgs({
  mentioned = ['Skolon', 'Läromedia', 'NE', 'Magma'],
  confirmedVendorName = 'Skolon',
  resellerRelationsByVendor = new Map([['ne', ['Läromedia']]]),
} = {}) {
  const conversations = [{
    id: 1, kommun_kod: '1980', kommun_namn: 'Västerås', role: 'central',
    state: 'DONE', contact_email: 'reg@vasteras.se',
  }];
  const messagesByConv = {
    1: [
      { id: 10, conversation_id: 1, direction: 'inbound', received_at: '2026-04-13T10:00:00Z',
        analysis_json: JSON.stringify({ intent: 'delivery', extracted: { mentioned_vendors: mentioned } }) },
      { id: 11, conversation_id: 1, direction: 'inbound', received_at: '2026-04-14T10:00:00Z', analysis_json: null },
    ],
  };
  const attachmentsByMsg = {
    11: [{ id: 100, filename: 'Skolon.pdf', mime_type: 'application/pdf', size_bytes: 1000,
           contract_is_contract: confirmedVendorName ? 1 : null,
           contract_document_type: null, contract_vendor_name: confirmedVendorName }],
  };
  return {
    kommun, conversations, messagesByConv, attachmentsByMsg,
    escalationsByConv: {}, signatures: {},
    vendorSlugsByName: new Map([['skolon', 'skolon']]),
    resellerRelationsByVendor,
  };
}

describe('renderKommunDetail — vertical Leverantörer panel', () => {
  it('renders vendors as vertical rows, not chips', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).toContain('class="vendor-row'); // row prefix (may carry has-pop/muted modifiers)
    expect(html).toContain('class="vendor-list"');
    // the old flat chip list is gone from the panel
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel).not.toContain('class="tag-list"');
  });

  it('removes the "🛒 Köper via ramavtal:" summary line entirely', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).not.toContain('Köper via ramavtal:');
    expect(html).not.toContain('🛒');
  });

  it('splits the Leverantörer section into "Avtal bekräftat" and "Nämnda"', () => {
    // Skolon (confirmed) + NE + Magma (mentioned non-channel) = 3 distinct.
    const html = renderKommunDetail(baseArgs());
    expect(html).toMatch(/Leverantörer \(3\)/);
    expect(html).toContain('Avtal bekräftat');
    expect(html).toContain('Nämnda');
  });

  it('a vendor with a page links to /leverantor/:slug', () => {
    const html = renderKommunDetail(baseArgs());
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel).toContain('href="/leverantor/skolon"');
  });

  it('a no-page vendor renders icon + muted unlinked name (no dead link)', () => {
    const html = renderKommunDetail(baseArgs());
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    // NE has no slug → must NOT be an anchor to a vendor page
    expect(panel).not.toContain('href="/leverantor/ne"');
    expect(panel).toContain('title="ingen leverantörssida än"');
  });

  it('shows a framed ▢ ramavtal pill linking to /ramavtal/:slug for an extracted relation', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).toContain('class="pill-ramavtal"');
    expect(html).toContain('href="/ramavtal/laromedia"');
    expect(html).toContain('▢ Läromedia');
  });

  it('does NOT show a ramavtal pill for a vendor without an extracted relation', () => {
    // No relations at all → no pill even though the kommun mentions channels.
    const html = renderKommunDetail(baseArgs({ resellerRelationsByVendor: new Map() }));
    expect(html).not.toContain('class="pill-ramavtal"');
  });

  it('a confirmed contract vendor shows under Avtal bekräftat and NOT under Nämnda', () => {
    const html = renderKommunDetail(baseArgs());
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel.slice(0, panel.indexOf('Nämnda'))).toContain('Skolon'); // confirmed side
    const namndaPart = panel.slice(panel.indexOf('Nämnda'));
    expect(namndaPart).toContain('NE'); // mentioned, non-channel
    expect(namndaPart).not.toContain('>Skolon<'); // confirmed → excluded from Nämnda
  });

  it('reseller-channel names are NOT listed as Nämnda rows', () => {
    const html = renderKommunDetail(baseArgs());
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    const namndaPart = panel.slice(panel.indexOf('Nämnda'));
    // Läromedia is a channel and only mentioned — it must not appear as a
    // "Nämnda" vendor name.
    expect(namndaPart).not.toContain('>Läromedia<');
  });

  it('empty state when no vendors at all', () => {
    const html = renderKommunDetail(baseArgs({ mentioned: [], confirmedVendorName: null, resellerRelationsByVendor: new Map() }));
    expect(html).toMatch(/Leverantörer \(0\)/);
    expect(html).toContain('Inga leverantörer fångade ännu.');
    expect(html).not.toContain('Köper via ramavtal:');
  });

  it('a confirmed vendor with a document shows a hover popover linking that document', () => {
    // baseArgs seeds a confirmed Skolon contract attachment (id 100, Skolon.pdf).
    const html = renderKommunDetail(baseArgs());
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel).toContain('vendor-pop');
    expect(panel).toContain('Mottagna dokument (1)');
    expect(panel).toContain('/attachments/100'); // opens the vendor's document
  });

  it('a mentioned-only vendor (no document) has no popover', () => {
    // NE is mentioned-only here — no contract, so no docs, no popover trigger.
    const html = renderKommunDetail(baseArgs({ mentioned: ['NE'], confirmedVendorName: null }));
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel).not.toContain('vendor-pop');
  });
});
