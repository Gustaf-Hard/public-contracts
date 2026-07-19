const AUTO_ACK_PATTERNS = [
  { name: 'arendenummer', re: /Ärendenummer\s*[:\-]\s*[Kk]\d{6,}/i, score: 0.8 },
  { name: 'tack_for_att', re: /Tack för att du hörde av dig/i, score: 0.7 },
  { name: 'flexite', re: /flexiteBPMS/i, score: 0.7 },
  { name: 'kvittens', re: /kvittens/i, score: 0.4 },
  { name: 'tagit_emot', re: /vi har tagit emot/i, score: 0.5 },
];

const CLARIFICATION_PATTERNS = [
  { name: 'precisera', re: /precisera/i, score: 0.8 },
  { name: 'fortydliga', re: /förtydliga|förtydligande/i, score: 0.7 },
  { name: 'tidsperiod', re: /tidsperiod/i, score: 0.5 },
  { name: 'specifika_system', re: /specifika (typer av )?system/i, score: 0.5 },
  { name: 'sammanstallning_eller', re: /sammanställning eller specifika/i, score: 0.7 },
  { name: 'onskar_jag_veta', re: /önskar jag veta/i, score: 0.5 },
  { name: 'behover_jag', re: /behöver (jag |vi )/i, score: 0.3 },
];

const DELIVERY_BODY_PATTERNS = [
  { name: 'bifogat', re: /bifogat|bifogar/i, score: 0.6 },
  { name: 'har_kommer', re: /här kommer/i, score: 0.5 },
  { name: 'avtalet', re: /avtalet|avtalshandlingar/i, score: 0.4 },
];

const DEAD_END_PATTERNS = [
  { name: 'finns_inte', re: /finns inte hos oss|finns ej|inga avtal/i, score: 0.8 },
  { name: 'hanvisar_till', re: /hänvisar (er |dig )?till/i, score: 0.7 },
  { name: 'omfattas_inte', re: /omfattas inte/i, score: 0.6 },
  { name: 'kan_ej_lamna_ut', re: /kan (vi )?inte lämna ut|kan ej lämna ut/i, score: 0.7 },
  { name: 'ligger_hos', re: /ligger hos|hanteras (centralt|hos)/i, score: 0.4 },
  // Declarative "these are/were all the contracts" — demonstrative + verb
  // order so OUR OWN receipt question ("Är detta samtliga avtal…?", verb
  // first) can never match, even when quoted back at us (finding 8).
  { name: 'samtliga_avtal', re: /((detta|dessa|det|de)( här)? (var|är) |var )samtliga avtal/i, score: 0.8 },
];

const ARENDENUMMER_RE = /Ärendenummer\s*[:\-]\s*([Kk]\d{6,})/i;

// True when a trimmed line begins the quoted trailing history — a reply
// attribution, a forwarded/Outlook header, or a dashed separator. Broadened
// beyond the original "Den/On … skrev/wrote:" so it also catches the
// leading-date Gmail Swedish attribution ("12 juni 2026 kl. 13:13 skrev Gustaf
// Hård af Segerstad <…>:") and the English "On Sat, Jun 6 … wrote:".
function startsQuotedTail(t) {
  if (!t) return false;
  if (/^-{2,}\s*Ursprungligt meddelande\s*-{2,}/i.test(t)) return true; // Outlook sv
  if (/^-{2,}\s*Original Message\s*-{2,}/i.test(t)) return true;
  if (/^-{3,}.+-{3,}$/.test(t)) return true; // generic "-----… -----" header
  if (/^(Från|From):\s/i.test(t)) return true; // forwarded header block
  if (/^(Den|On) .{4,80}skrev.*:$/i.test(t)) return true; // Gmail sv "Den … skrev X:"
  if (/ skrev .*:$/i.test(t)) return true; // leading-date "… skrev … <…>:"
  if (/wrote:$/i.test(t)) return true; // English "On … wrote:"
  return false;
}

// Split a mail body into the new visible text and the quoted trailing history.
// `visible` = everything before the first quote marker (an attribution line, a
// forwarded/Outlook header, or a '>'-prefixed line); `quoted` = that marker
// line and everything after it. A body with no quoted tail returns
// `{ visible: whole, quoted: '' }`. Signature lines stay in `visible`.
export function splitQuotedText(body) {
  const lines = String(body ?? '').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (startsQuotedTail(t) || t.startsWith('>')) { cut = i; break; }
  }
  if (cut === -1) return { visible: lines.join('\n'), quoted: '' };
  return { visible: lines.slice(0, cut).join('\n'), quoted: lines.slice(cut).join('\n') };
}

// Strip quoted reply content so patterns never match OUR OWN text echoed back
// (a kommun reply usually quotes the T_RECEIPT question "Är detta samtliga
// avtal…?"). Thin wrapper over splitQuotedText — the visible part only.
export function stripQuotedText(body) {
  return splitQuotedText(body).visible;
}

// Fallback "this was everything" detector over the UNQUOTED part of the body
// (review M9): used only when no LLM analysis is available. Deliberately the
// declarative shape — demonstrative BEFORE the verb — so a question
// ("Är detta samtliga avtal?", verb first) does not match. Covers both past
// ("Detta var samtliga avtal") and present tense ("Detta är samtliga avtal"),
// which the pre-M9 broad /samtliga avtal/ caught and the first narrowing
// dropped (hardening finding 8).
const CLOSER_RE = /((detta|dessa|det|de)( här)? (var|är) |var )samtliga avtal|inga (fler|ytterligare) avtal/i;
export function isCloserText(body) {
  return CLOSER_RE.test(stripQuotedText(body));
}

const THRESHOLD = 0.6;
const DELIVERY_THRESHOLD = 0.5;
const MARGIN = 0.2;

function scoreClass(patterns, body) {
  const hits = [];
  let total = 0;
  for (const p of patterns) {
    if (p.re.test(body)) {
      hits.push(p.name);
      total += p.score;
    }
  }
  return { score: Math.min(total, 1), signals: hits };
}

export function classify(message) {
  const body = message.body ?? '';
  const attachments = message.attachment_count ?? 0;

  const candidates = {
    auto_ack: scoreClass(AUTO_ACK_PATTERNS, body),
    clarification: scoreClass(CLARIFICATION_PATTERNS, body),
    delivery: (() => {
      if (attachments < 1) return { score: 0, signals: [] };
      const r = scoreClass(DELIVERY_BODY_PATTERNS, body);
      return { score: Math.min(r.score + 0.5, 1), signals: ['has_attachment', ...r.signals] };
    })(),
    dead_end: scoreClass(DEAD_END_PATTERNS, body),
  };

  const ranked = Object.entries(candidates)
    .map(([cls, { score, signals }]) => ({ cls, score, signals }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  const extracted = {};
  const arendeMatch = body.match(ARENDENUMMER_RE);
  if (arendeMatch) extracted.arendenummer = arendeMatch[1];

  if (top.cls === 'delivery' && top.score >= DELIVERY_THRESHOLD && (top.score - (second?.score ?? 0)) >= MARGIN) {
    return { class: 'delivery', confidence: top.score, signals: top.signals, extracted };
  }

  if (top.score < THRESHOLD || (top.score - (second?.score ?? 0)) < MARGIN) {
    return {
      class: 'unknown',
      confidence: top.score,
      signals: top.signals,
      extracted,
    };
  }

  return {
    class: top.cls,
    confidence: top.score,
    signals: top.signals,
    extracted,
  };
}
