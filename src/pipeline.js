// The collection pipeline as the operator describes it: a kommun moves from
// "not contacted" to "done" through a fixed set of stages. Pure — no IO, no DB.
//
// The FSM has more states than the operator needs to see (AWAITING_PRECISION
// and ACK_RECEIVED are both "we are talking to them"), so this collapses them.
// Off-track states are NOT hidden in a tidy funnel: a dead end or a case
// needing a human is real and must be its own column, or the board would show
// a cleaner pipeline than we actually have.

export const STAGES = [
  { key: 'ej_kontaktad', label: 'Ej kontaktad', hint: 'ingen begäran skickad' },
  { key: 'kontaktad', label: 'Kontaktad', hint: 'skickat, inget svar än' },
  { key: 'dialog', label: 'I kontakt', hint: 'de har svarat' },
  { key: 'avtal_kommer', label: 'Avtal kommer', hint: 'handlingar på väg in' },
  { key: 'slutkoll', label: 'Slutkoll', hint: 'checklistan ute' },
  { key: 'klart', label: 'Klart', hint: 'bekräftat komplett' },
  { key: 'stoppat', label: 'Stoppat', hint: 'återvändsgränd eller behöver dig' },
];

const BY_STATE = {
  INITIAL: 'kontaktad',              // scheduled: the send is already committed
  SENT: 'kontaktad',
  ACK_RECEIVED: 'dialog',
  AWAITING_PRECISION: 'dialog',
  DELIVERING: 'avtal_kommer',
  CROSSCHECK: 'slutkoll',
  REFRESH_DUE: 'slutkoll',
  DONE: 'klart',
  DEAD_END: 'stoppat',
  NEEDS_HUMAN: 'stoppat',
};

export function stageForState(state) {
  return BY_STATE[state] ?? 'dialog';
}

// One row per KOMMUN, not per conversation: the operator thinks in
// municipalities, and a kommun with three förvaltningar is one dot on the
// board. Its stage is the FURTHEST any of its conversations has reached, so
// parallel threads cannot drag a kommun backwards — except that 'stoppat'
// never wins, since one dead förvaltning does not stop the kommun.
const ORDER = STAGES.map((s) => s.key);

export function buildPipeline({ municipalities = [], conversations = [] } = {}) {
  const byKommun = new Map();
  for (const c of conversations) {
    const stage = stageForState(c.state);
    const prev = byKommun.get(c.kommun_kod);
    if (!prev) { byKommun.set(c.kommun_kod, { ...c, stage }); continue; }
    // 'stoppat' only survives if nothing else progressed.
    const rank = (s) => (s === 'stoppat' ? -1 : ORDER.indexOf(s));
    if (rank(stage) > rank(prev.stage)) byKommun.set(c.kommun_kod, { ...c, stage });
  }

  const columns = Object.fromEntries(STAGES.map((s) => [s.key, []]));
  for (const m of municipalities) {
    const hit = byKommun.get(m.kommun_kod);
    columns[hit ? hit.stage : 'ej_kontaktad'].push({
      kommun_kod: m.kommun_kod,
      kommun_namn: m.kommun_namn,
      conv_id: hit?.id ?? null,
      state: hit?.state ?? null,
    });
  }
  for (const key of Object.keys(columns)) {
    columns[key].sort((a, b) => a.kommun_namn.localeCompare(b.kommun_namn, 'sv'));
  }
  return { stages: STAGES, columns, counts: Object.fromEntries(STAGES.map((s) => [s.key, columns[s.key].length])) };
}
