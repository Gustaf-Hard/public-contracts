// Suggested ärenden from an external handoff. Pure: no IO, no DB — the caller
// passes the stored analysis, the message body and the kommun's home domain.
//
// Reads analysis.intent, NOT the stored classification column: a handoff is
// deliberately persisted as classification 'unknown' (see
// analysisToLegacyClassification), so a rule keyed on the column never fires.
// See docs/superpowers/specs/2026-07-31-handoff-suggested-arenden-design.md

// 'http://www.goteborg.se' → 'goteborg.se'. Same derivation as crawl.js.
export function homeDomainFromWebbplats(webbplats) {
  if (!webbplats) return null;
  try {
    return new URL(webbplats).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// Dot-anchored, never a bare endsWith: 'xgoteborg.se' must not match
// 'goteborg.se' (CLAUDE.md, cross-domain filter).
function onDomain(email, homeDomain) {
  if (!homeDomain) return false;
  const d = String(email).split('@')[1]?.toLowerCase();
  if (!d) return false;
  return d === homeDomain || d.endsWith('.' + homeDomain);
}

const ASCII = (s) => String(s ?? '').toLowerCase()
  .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Swedish compounds link with a morpheme that has to come back off:
// 'utbildning-s-förvaltningen' drops a linking 's', but 'grundskol-e-' replaced
// the base word's final 'a'. A generic /e$/ rule would corrupt
// 'Serviceförvaltningen' into 'servica', so the vowel cases are a whitelist —
// the same call the genitive fix in seed.js makes. Extend it when a real
// förvaltning stems wrong; do not reach for a heuristic.
const LINKING_VOWEL_STEMS = new Map([
  ['grundskole', 'grundskola'],
  ['forskole', 'forskola'],
  ['gymnasie', 'gymnasie'],
]);

// 'Utbildningsförvaltningen' → 'utbildning'; 'Grundskoleförvaltningen' → 'grundskola'.
function roleFromForvaltning(forvaltning) {
  const first = ASCII(forvaltning).split(' ')[0] ?? '';
  const base = first
    .replace(/forvaltningen$|forvaltning$/, '')
    .replace(/namnden$|namnd$/, '')
    .replace(/kontoret$|kontor$/, '');
  // A linking 's' only, and only when a usable stem survives it.
  const stem = LINKING_VOWEL_STEMS.get(base)
    ?? (/[a-z]{3,}s$/.test(base) ? base.slice(0, -1) : base);
  return stem.length >= 3 ? stem : 'handoff';
}

// Split one extraction's raw fields into one contact per address. The LLM packs
// several addresses into handoff_to_email ('a@x.se;b@x.se'), so anything that
// treats the field as a single address produces an unusable recipient. Shared
// by the suggestion panel and storage.listHandoffContacts so the two cannot
// drift apart.
export function splitHandoffContacts({ email, forvaltning, usedRoles = [] }) {
  if (!email) return [];

  const emails = [];
  const seen = new Set();
  for (const part of String(email).split(/[;,\s]+/)) {
    const e = part.trim().toLowerCase();
    if (!e || !e.includes('@') || seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  if (emails.length === 0) return [];

  const labels = String(forvaltning ?? '')
    .split(/\s+och\s+|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Pair by index only when the counts line up; otherwise every address carries
  // the full text rather than a guessed label.
  const paired = labels.length === emails.length;
  const fullLabel = labels.join(' och ');

  const taken = new Set(usedRoles);
  return emails.map((e, i) => {
    const label = paired ? labels[i] : fullLabel;
    let roleSlug = roleFromForvaltning(label);
    if (taken.has(roleSlug)) {
      let n = 2;
      while (taken.has(`${roleSlug}-${n}`)) n++;
      roleSlug = `${roleSlug}-${n}`;
    }
    taken.add(roleSlug);
    return { email: e, forvaltning: label, roleSlug };
  });
}

export function parseHandoffTargets({ analysis, bodyText = '', homeDomain = null, usedRoles = [] }) {
  if (!analysis || analysis.intent !== 'handoff') return [];

  const body = String(bodyText ?? '').toLowerCase();
  return splitHandoffContacts({
    email: analysis.extracted?.handoff_to_email,
    forvaltning: analysis.extracted?.handoff_to_forvaltning,
    usedRoles,
  }).map((c) => ({
    ...c,
    verbatim: body.includes(c.email),
    sameDomain: onDomain(c.email, homeDomain),
  }));
}
