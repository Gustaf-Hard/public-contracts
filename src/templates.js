import { WATCHLIST } from './watchlist.js';

function scopeText(role) {
  return role === 'central' ? 'kommunen' : 'utbildningsförvaltningen';
}

function signature({ from_name, from_email }) {
  return `Med vänliga hälsningar,\n${from_name}\n${from_email}`;
}

export function T_INITIAL(ctx) {
  return {
    subject: `Begäran om allmänna handlingar – ${ctx.kommun_namn} kommun – digitala verktyg, lärplattformar och läromedel`,
    body: [
      'Hej,',
      '',
      `Jag skriver till ${ctx.kommun_namn} kommun med en begäran om allmänna handlingar med stöd av offentlighetsprincipen (2 kap. tryckfrihetsförordningen).`,
      '',
      'Jag önskar ta del av de faktiska avtalsdokumenten för samtliga gällande avtal avseende digitala verktyg, lärplattformar och läromedel som används inom skola och utbildning – direkt eller indirekt – inom kommunen.',
      '',
      'Detta gäller även avtal som ingåtts indirekt, t.ex. via ramavtal eller inköpscentral (såsom Adda/SKL Kommentus) eller via återförsäljare och distributörer (såsom Atea eller Läromedia).',
      '',
      'Specifikt önskar jag information om aktiva avtal (ej utgångna):',
      '- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)',
      '- Digitala läromedel och licenser',
      '- Administrativa system kopplade till undervisning',
      '',
      'Per avtal önskar jag följande uppgifter där möjligt:',
      '- Leverantör',
      '- Produktnamn/tjänst',
      '- Avtalsvärde eller årskostnad',
      '- Avtalstid (start- och slutdatum)',
      '',
      'Handlingarna önskas i digital form (PDF eller motsvarande).',
      '',
      'Om delar av handlingarna bedöms sekretessbelagda ber jag om ett motiverat avslagsbeslut för dessa delar enligt 6 kap. 3 § offentlighets- och sekretesslagen.',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_PRECISION(ctx) {
  const scope = scopeText(ctx.role);
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack för snabbt svar! Jag preciserar gärna min begäran.',
      '',
      `Jag efterfrågar aktiva avtal (ej utgångna) avseende digitala verktyg inom ${scope}:`,
      '- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)',
      '- Digitala läromedel och licenser',
      '- Administrativa system kopplade till undervisning',
      '',
      'Detta gäller även avtal som ingåtts indirekt, t.ex. via ramavtal, inköpscentral eller återförsäljare/distributör (såsom Atea eller Läromedia).',
      '',
      'Per avtal önskar jag: leverantör, produktnamn/tjänst, avtalsvärde eller årskostnad, avtalstid (start- och slutdatum). Dels de fullständiga avtalshandlingarna i PDF-format.',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_RECEIPT(ctx) {
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack så mycket för avtalen — jag har tagit emot dem. Är detta samtliga avtal eller är fler på väg?',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_FOLLOWUP_NUDGE(ctx) {
  return {
    subject: `Påminnelse: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      `Jag vill bara följa upp om min begäran om allmänna handlingar (skickad ${ctx.days_since_send} dagar sedan). Behöver ni ytterligare information från min sida för att kunna behandla ärendet?`,
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_FOLLOWUP_CLOSE(ctx) {
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack igen för avtalen jag fått. Har ni ytterligare avtal som inte skickats än, eller kan vi betrakta begäran som slutförd från er sida?',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

const SV_MONTH_NAMES = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

// '2026-07-20' → '20 juli 2026'. Non-ISO input (an LLM slip like "20 juli")
// is returned verbatim — a readable date in the draft always beats a crash.
export function formatDateSv(iso) {
  const m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return iso ?? '';
  const month = SV_MONTH_NAMES[Number(m[2]) - 1];
  if (!month) return iso;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

// Graceful "we'll wait" ack for a delay promise / out-of-office autoreply that
// states a return date. Names the date so the counterpart (and the approving
// operator) sees exactly what we committed to waiting for.
export function T_DELAY_ACK(ctx) {
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      `Tack för ditt svar! Då avvaktar vi till ${formatDateSv(ctx.delay_date)} och hör av oss igen om vi inte fått något då.`,
      '',
      signature(ctx),
    ].join('\n'),
  };
}

// Join a list the Swedish way: "A", "A och B", "A, B och C".
function listSv(items) {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' och ' + items[items.length - 1];
}

// Which reply to draft for a delivery, from what actually arrived.
export function chooseDeliveryReply({ received = [], missing = [] } = {}) {
  return { template: missing.length > 0 ? 'T_REQUEST_MISSING' : 'T_RECEIPT' };
}

// Derive received (real contracts), missing (named but undocumented), and all
// (every vendor named anywhere in the delivery) from a delivery's contract rows.
export function computeReceivedMissing(rows = []) {
  const all = [];
  const seenAll = new Set();
  const addAll = (name) => {
    if (!name) return;
    const k = name.toLowerCase();
    if (!seenAll.has(k)) { seenAll.add(k); all.push(name); }
  };

  // Parse each row's analysis_json once.
  const parsed = rows.map((r) => {
    let a = r.analysis_json;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    return { r, a };
  });

  const received = [];
  const seen = new Set();
  for (const { r } of parsed) {
    if (r.vendor_name) addAll(r.vendor_name);
    if (r.is_contract && r.vendor_name) {
      const k = r.vendor_name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); received.push(r.vendor_name); }
    }
  }

  const missing = [];
  const seenMissing = new Set(seen); // never ask for something already received
  for (const { a } of parsed) {
    for (const m of a?.mentioned_agreements ?? []) {
      if (m && m.vendor) addAll(m.vendor);
      if (m && m.doc_attached === false && m.vendor) {
        const k = m.vendor.toLowerCase();
        if (!seenMissing.has(k)) { seenMissing.add(k); missing.push(m.vendor); }
      }
    }
  }

  return { received, missing, all };
}

// Perpetual-refresh re-contact (2026-07-09 design §3.5). Human-approved via the
// normal escalation flow. Two deliberate rules from the owner's guidance:
//   - the renewal question NAMES the specific expiring contract(s) at review;
//   - the net-new question stays OPEN-ENDED — we do NOT parrot our full
//     extraction back at the kommun (asking them to confirm everything we hold).
export function T_UPDATE(ctx) {
  const reviewContracts = ctx.review_contracts ?? [];
  const arende = ctx.arendenummer
    ? ` (ärendenummer ${ctx.arendenummer})`
    : '';

  // One named sentence covering the expiring contract(s).
  let renewalAsk;
  if (reviewContracts.length) {
    const named = reviewContracts.map((c) => {
      const end = c.period_end ? ` (avtalstid t.o.m. ${c.period_end})` : '';
      return `${c.vendor_name ?? 'okänd leverantör'}${end}`;
    });
    renewalAsk = `Enligt de handlingar jag tidigare fått gäller detta ert avtal med ${listSv(named)}. Har avtalet/avtalen förnyats, och kan jag i så fall ta del av det/de nu gällande avtalet/avtalen?`;
  } else {
    renewalAsk = 'Har något av de avtal jag tidigare fått del av förnyats sedan dess, och kan jag i så fall ta del av de nu gällande avtalen?';
  }

  return {
    subject: `Re: ${ctx.thread_subject ?? 'Begäran om allmänna handlingar'}`,
    body: [
      'Hej,',
      '',
      `Jag återkommer angående min tidigare begäran om allmänna handlingar${arende} avseende digitala verktyg, lärplattformar och läromedel inom skola och utbildning.`,
      '',
      renewalAsk,
      '',
      'Har ni därutöver tecknat några nya avtal avseende digitala verktyg, lärplattformar eller läromedel sedan dess?',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

// Follow-up when a delivery lacks (some of) the actual avtal documents.
export function T_REQUEST_MISSING(ctx) {
  const received = ctx.received ?? [];
  const missing = ctx.missing ?? [];
  let ask;
  if (missing.length && received.length) {
    ask = `Tack för avtalen gällande ${listSv(received)}. Jag saknar dock ännu de faktiska avtalshandlingarna för ${listSv(missing)} — kan ni skicka dem?`;
  } else if (missing.length) {
    ask = `Tack för ert svar. Själva avtalshandlingarna verkar dock inte vara bifogade — kan ni skicka de fullständiga avtalen för ${listSv(missing)}?`;
  } else {
    ask = 'Tack för ert svar. Jag ser dock inte de faktiska avtalshandlingarna bifogade — kan ni skicka de fullständiga avtalen?';
  }
  // Net-new / watchlist probe. edit-review showed T_REQUEST_MISSING was the one
  // template the operator consistently rewrote — every time to append a question
  // about OTHER digital school services, naming the watchlisted vendors. Bake it
  // in from the watchlist (single source of truth) so it no longer needs editing.
  const probe = `Har ni därutöver avtal för andra digitala tjänster inom skolan, till exempel ${listSv(WATCHLIST.map((w) => w.canonical))} eller liknande?`;
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: ['Hej,', '', ask, '', probe, '', signature(ctx)].join('\n'),
  };
}
