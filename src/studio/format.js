// Studio number and date formatting. Swedish conventions: decimal comma,
// no-break space as thousands separator (so a figure never wraps), unit after a
// plain space. Unknown is always the word "okänt", never 0 and never a dash.

export const UNKNOWN = 'okänt';
const NBSP = ' ';
const MINUS = '−';

const known = (n) => typeof n === 'number' && Number.isFinite(n);

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

// One decimal with a comma, dropping a trailing ",0".
function oneDecimal(x) {
  const r = Math.round(x * 10) / 10;
  const [i, d] = r.toFixed(1).split('.');
  return d === '0' ? group(i) : `${group(i)},${d}`;
}

const sign = (n) => (n < 0 ? MINUS : '');

export function fmtInt(n) {
  if (!known(n)) return UNKNOWN;
  return sign(n) + group(String(Math.round(Math.abs(n))));
}

// A price per elev: below 10 one decimal ("0,4"), so a small price never
// reads as 0; otherwise a whole number.
export function fmtPrice(n) {
  if (!known(n)) return UNKNOWN;
  return Math.abs(n) < 10 ? sign(n) + oneDecimal(Math.abs(n)) : fmtInt(n);
}

export function fmtKr(n) {
  if (!known(n)) return UNKNOWN;
  return `${fmtInt(n)} kr`;
}

// "30,9 mkr", "250 mkr", "412 tkr", "1,3 mdkr", "640 kr".
export function fmtKrCompact(n) {
  if (!known(n)) return UNKNOWN;
  const a = Math.abs(n);
  const s = sign(n);
  const scaled = (div, unit) => {
    const v = a / div;
    return `${s}${v >= 100 ? group(String(Math.round(v))) : oneDecimal(v)} ${unit}`;
  };
  if (Math.round(a / 1e8) >= 10) return scaled(1e9, 'mdkr');
  if (Math.round(a / 1e3) >= 1000) return scaled(1e6, 'mkr');
  if (a >= 1000) return `${s}${group(String(Math.round(a / 1e3)))} tkr`;
  return `${s}${group(String(Math.round(a)))} kr`;
}

// Share 0..1 → "42 %"; below 10 % one decimal ("4,2 %").
export function fmtPct(x) {
  if (!known(x)) return UNKNOWN;
  const p = x * 100;
  return `${Math.abs(p) < 10 ? sign(p) + oneDecimal(Math.abs(p)) : fmtInt(p)} %`;
}

// "känd för 41 av 63 avtal"
export function basisLine(knownCount, total, noun = 'avtal') {
  if (!known(knownCount) || !known(total)) return UNKNOWN;
  return `känd för ${fmtInt(knownCount)} av ${fmtInt(total)} ${noun}`;
}

function parseIsoDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

// Whole calendar months from a to b (b >= a).
function wholeMonths(a, b) {
  return (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
}

// "om 2 mån", "inom en månad", "för 3 mån sedan".
export function monthsUntil(date, today) {
  const t = parseIsoDate(date);
  const now = parseIsoDate(today ?? new Date());
  if (!t || !now) return UNKNOWN;
  const future = t.y * 10000 + t.m * 100 + t.d >= now.y * 10000 + now.m * 100 + now.d;
  if (future) {
    const n = wholeMonths(now, t);
    return n < 1 ? 'inom en månad' : `om ${n} mån`;
  }
  const n = wholeMonths(t, now);
  return n < 1 ? 'för mindre än en månad sedan' : `för ${n} mån sedan`;
}

// Footer: "1 520 aktiva avtal (1 676 insamlade) från 185 kommuner · uppdaterad 2026-10-26".
export function basisSentence(basis) {
  if (typeof basis === 'string') return basis;
  if (!basis) return 'Underlaget kunde inte läsas just nu.';
  const active = basis.active ?? 0;
  const collected = basis.collected ?? 0;
  const kommuner = basis.kommuner_with_avtal ?? 0;
  const parts = [
    `${fmtInt(active)} ${active === 1 ? 'aktivt avtal' : 'aktiva avtal'}`,
    `(${fmtInt(collected)} ${collected === 1 ? 'insamlat' : 'insamlade'})`,
    `från ${fmtInt(kommuner)} ${kommuner === 1 ? 'kommun' : 'kommuner'}`,
  ];
  return parts.join(' ') + (basis.updated ? ` · uppdaterad ${basis.updated}` : '');
}
