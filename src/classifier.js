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

// --- Autosvar / out-of-office (OOO) recognition (2026-07-19 design §1) ---
//
// CONSERVATIVE, high-precision markers only. The failure mode we must avoid is
// tagging a REAL kommun reply (delivery / clarification / handoff / fee) as an
// autoresponder — that would silently suppress a needed escalation. When in
// doubt we do NOT match; the message falls through to the normal classifier.
//
// Two families of markers, both matched case-insensitively on the UNQUOTED body
// (or subject) so a mail that merely QUOTES "semester" in its trailing history
// can never trip the detector:
//   1. An explicit autoresponder tag — the strongest signal a machine sent it:
//      "Autosvar:", "Automatiskt svar", "Auto-reply", "Out of office", "OoO".
//   2. An absence phrase ("frånvar…") COMBINED with a return/vacation cue
//      ("är åter", "åter den", "tillbaka", "semester"). Neither half alone is
//      enough — "tillbaka" or "semester" on their own appear in ordinary prose.
const OOO_TAG_RE = /\bAutosvar\b|\bAutomatiskt svar\b|\bAuto-?reply\b|\bOut of office\b|\bOoO\b/i;
const OOO_ABSENCE_RE = /\bfrånvar/i;
const OOO_RETURN_RE = /\bär åter\b|\båter den\b|\btillbaka\b|\bsemester\b/i;

function isOooText(subject, visibleBody) {
  const hay = `${subject ?? ''}\n${visibleBody ?? ''}`;
  if (OOO_TAG_RE.test(hay)) return true;
  if (OOO_ABSENCE_RE.test(hay) && OOO_RETURN_RE.test(hay)) return true;
  return false;
}

// Extract the stated return date from an OOO body (UNQUOTED). ISO first, then
// Swedish prose ("är åter 20 juli", "tillbaka 3 augusti 2026"). Yearless dates
// resolve to the next occurrence relative to todayIso. Returns YYYY-MM-DD or
// null — precision over recall: an unparseable date just means no date.
const OOO_ISO_RE = /(\d{4})-(\d{2})-(\d{2})/;
const SV_MONTHS_CLS = {
  januari: 1, februari: 2, mars: 3, april: 4, maj: 5, juni: 6,
  juli: 7, augusti: 8, september: 9, oktober: 10, november: 11, december: 12,
};
function pad2c(n) { return String(n).padStart(2, '0'); }
function isRealDateCls(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
export function extractReturnDate(visibleBody, { todayIso } = {}) {
  const s = String(visibleBody ?? '').toLowerCase();
  const iso = s.match(OOO_ISO_RE);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDateCls(y, mo, d) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }
  const m = s.match(/(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = SV_MONTHS_CLS[m[2]];
  let year = m[3] ? Number(m[3]) : null;
  if (year == null) {
    const todayYear = todayIso && /^\d{4}-\d{2}-\d{2}$/.test(todayIso) ? Number(todayIso.slice(0, 4)) : new Date().getUTCFullYear();
    year = todayYear;
    const candidate = `${year}-${pad2c(month)}-${pad2c(day)}`;
    if (todayIso && candidate < todayIso) year += 1;
  }
  if (!isRealDateCls(year, month, day)) return null;
  return `${year}-${pad2c(month)}-${pad2c(day)}`;
}

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

  // Autosvar / OOO recognition (2026-07-19 §1) runs FIRST, on the UNQUOTED body
  // + subject, so a mail quoting "semester" in its history never trips it.
  // Guarded to precision: a message CARRYING ATTACHMENTS is a real delivery, not
  // an autoresponder — never let an OOO marker in a delivery cover shadow it.
  const visible = stripQuotedText(body);
  if (attachments < 1 && isOooText(message.subject, visible)) {
    const extracted = {};
    const arendeMatchOoo = body.match(ARENDENUMMER_RE);
    if (arendeMatchOoo) extracted.arendenummer = arendeMatchOoo[1];
    const returnDate = extractReturnDate(visible, { todayIso: message.today_iso });
    if (returnDate) extracted.return_date = returnDate;
    return { class: 'auto_reply', confidence: 0.85, signals: ['ooo_autosvar'], extracted };
  }

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
