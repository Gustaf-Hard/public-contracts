// tests/kommun-vendor-panel.test.js
// Pure-view tests for the split Leverantörer sidebar panel + "Köper via
// ramavtal" line (2026-07-18 kommun-vendor-panel design). No DB, no IO —
// renderKommunDetail takes all its data via params.
import { describe, it, expect } from 'vitest';
import { renderKommunDetail } from '../src/dashboard-views.js';

const kommun = { kommun_kod: '1980', kommun_namn: 'Västerås', lan: 'Västmanland', folkmangd: 1, contacts: [] };

// One DONE conversation with two inbound messages: one mentions Skolon +
// Läromedia in prose, one carries a CONFIRMED Skolon contract attachment.
function baseArgs({ mentioned = ['Skolon', 'Läromedia'], confirmedVendorName = 'Skolon' } = {}) {
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
  };
}

describe('renderKommunDetail — Leverantörer panel + Köper via', () => {
  it('renders "Köper via ramavtal: …" when a channel is present', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).toContain('Köper via ramavtal:');
    expect(html).toContain('Läromedia');
    expect(html).toContain('Skolon');
  });

  it('splits the Leverantörer section into "Avtal bekräftat" and "Nämnda"', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).toMatch(/Leverantörer \(2\)/);
    expect(html).toContain('Avtal bekräftat');
    expect(html).toContain('Nämnda');
  });

  it('a confirmed contract vendor shows under Avtal bekräftat and NOT under Nämnda', () => {
    const html = renderKommunDetail(baseArgs());
    // Scope to the sidebar Leverantörer panel (E-postadresser follows it), then
    // to the "Nämnda" (mentioned-only) subgroup within it.
    const panel = html.slice(html.indexOf('Leverantörer ('), html.indexOf('E-postadresser'));
    expect(panel.slice(0, panel.indexOf('Nämnda'))).toContain('Skolon'); // confirmed side
    const namndaPart = panel.slice(panel.indexOf('Nämnda'));
    expect(namndaPart).toContain('Läromedia'); // mentioned only
    expect(namndaPart).not.toContain('Skolon'); // confirmed → excluded from Nämnda
  });

  it('reseller channel vendors get the 🛒 pill', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).toContain('🛒');
    expect(html).toContain('pill-reseller');
  });

  it('main column no longer contains the old "Nämnda leverantörer" heading', () => {
    const html = renderKommunDetail(baseArgs());
    expect(html).not.toContain('Nämnda leverantörer');
  });

  it('empty state when no vendors at all', () => {
    const html = renderKommunDetail(baseArgs({ mentioned: [], confirmedVendorName: null }));
    expect(html).toMatch(/Leverantörer \(0\)/);
    expect(html).toContain('Inga leverantörer fångade ännu.');
    expect(html).not.toContain('Köper via ramavtal:');
  });
});
