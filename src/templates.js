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
