// Deterministic coverage facts over what a kommun has ACTUALLY delivered.
// Pure: no IO, no DB (same rule as vendor-kb.js) — callers pass stored rows in.
//
// This is what grounds the missing-contracts draft. The 2026-07-20 incident
// (Huddinge/Boxholm/Bräcke) was a draft claiming vendors were received/missing
// from model memory rather than from files; every field here is derived from
// stored contract rows, and a name the KB does not know is passed through
// verbatim rather than guessed at or dropped.
// See docs/superpowers/specs/2026-07-28-vendor-product-knowledge-base-design.md

import { COMPANIES, resolveCompany, probeName } from './vendor-kb.js';

function parseAnalysis(a) {
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return null; } }
  return a && typeof a === 'object' ? a : null;
}

// buildCoverageFacts(rows) → the honest ground truth for one conversation.
//
//   received            KB services we hold a real contract for, products nested
//   received_unresolved real contracts whose vendor is not in the KB (verbatim)
//   channels_seen       procurement channels seen anywhere (drives the avrop ask)
//   undocumented        services named but with no document attached
//   not_yet_seen        watchlist services with NO trace at all, probe-labelled
//   has_missing         anything still owed to us
//
// Rules: a delivered product counts for its company (Magma ⇒ Radish received);
// a received company never appears in `undocumented` or `not_yet_seen`; a
// `role: 'channel'` name is never a missing contract — we ask for the kommun's
// own avrop behind it instead.
export function buildCoverageFacts(rows = []) {
  const parsed = rows.map((r) => ({ r, a: parseAnalysis(r.analysis_json) }));

  const received = new Map();          // slug → { slug, canonical, role, matchedAs, products }
  const receivedUnresolved = [];
  const seenUnresolved = new Set();
  const channels = new Map();          // slug → { slug, canonical }
  const mentioned = new Set();         // slugs named anywhere, documented or not

  const noteChannel = (c) => { if (!channels.has(c.slug)) channels.set(c.slug, { canonical: c.canonical, slug: c.slug }); };

  // Pass 1 — real contracts. These are the only "received" claims we will make.
  for (const { r, a } of parsed) {
    const products = (a?.products ?? []).filter(Boolean);
    const names = [r.vendor_name, ...products].filter(Boolean);
    let resolved = null;
    for (const n of names) {
      resolved = resolveCompany(n);
      if (resolved) break;
    }
    if (resolved) mentioned.add(resolved.slug);
    if (!r.is_contract) continue;

    if (!resolved) {
      if (r.vendor_name && !seenUnresolved.has(r.vendor_name.toLowerCase())) {
        seenUnresolved.add(r.vendor_name.toLowerCase());
        receivedUnresolved.push(r.vendor_name);
      }
      continue;
    }
    if (resolved.role === 'channel') {
      // A ramavtal PDF is a real document, but not an avtal with a service.
      noteChannel(resolved);
      continue;
    }
    const entry = received.get(resolved.slug)
      ?? { slug: resolved.slug, canonical: resolved.canonical, role: resolved.role, matchedAs: resolved.matchedAs, products: [] };
    for (const p of products) if (!entry.products.includes(p)) entry.products.push(p);
    received.set(resolved.slug, entry);
  }

  // Pass 2 — names the documents merely MENTION. Channels are filed as channels;
  // anything already received is not asked for again.
  const undocumented = [];
  const seenUndoc = new Set();
  for (const { a } of parsed) {
    for (const m of a?.mentioned_agreements ?? []) {
      const name = m?.vendor;
      if (!name) continue;
      const resolved = resolveCompany(name);
      if (resolved) {
        mentioned.add(resolved.slug);
        if (resolved.role === 'channel') { noteChannel(resolved); continue; }
      }
      if (m.doc_attached !== false) continue;
      if (resolved) {
        if (received.has(resolved.slug) || seenUndoc.has(resolved.slug)) continue;
        seenUndoc.add(resolved.slug);
        undocumented.push({ slug: resolved.slug, canonical: resolved.canonical });
      } else {
        const k = `name:${name.toLowerCase()}`;
        if (seenUndoc.has(k)) continue;
        seenUndoc.add(k);
        undocumented.push({ name });
      }
    }
  }

  // Watchlist services with no trace at all — the probe list. "Mentioned but
  // undocumented" is deliberately excluded: we already know they use it, and
  // asking "har ni avtal med X?" about something they just named reads badly.
  const not_yet_seen = COMPANIES
    .filter((c) => c.watchlist && c.role === 'service' && !received.has(c.slug) && !mentioned.has(c.slug))
    .map((c) => ({ slug: c.slug, canonical: c.canonical, probeLabel: probeName(c) }));

  return {
    received: [...received.values()],
    received_unresolved: receivedUnresolved,
    channels_seen: [...channels.values()],
    undocumented,
    not_yet_seen,
    has_missing: undocumented.length > 0,
  };
}
