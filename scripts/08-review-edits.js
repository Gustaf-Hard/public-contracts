#!/usr/bin/env node
// On-demand edit-review report (read-only; no cron, no daemon changes).
//
// The operator edits bot drafts before sending; every edit is stored in the
// decisions table. This script scores each edit with a normalized edit
// distance (src/edit-review.js), keeps the big rewrites, and writes a
// markdown report grouped by draft_template so "which template gets
// consistently rewritten" is obvious at a glance. Feed the report back into
// templates/prompts/classifier (resurrects deferred review finding M3).
//
// Usage:
//   node scripts/08-review-edits.js [--min=0.35] [--db=data/pilot.db] \
//        [--out=data/edit-review.md] [--dry-run]
//
// Safe to run while the pilot is live: the DB is only SELECTed (no migrate,
// no writes); output is a markdown file (skipped with --dry-run).
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/storage.js';
import { editDivergence, severity } from '../src/edit-review.js';

const NO_TEMPLATE = '(no template)';

export function parseArgs(argv) {
  const args = { min: 0.35, db: 'data/pilot.db', out: 'data/edit-review.md', dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--min=')) {
      const v = Number(a.slice('--min='.length));
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`--min must be a number between 0 and 1, got: ${a.slice('--min='.length)}`);
      }
      args.min = v;
    } else if (a.startsWith('--db=')) {
      args.db = a.slice('--db='.length);
    } else if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

/** Attach { divergence, severity } to each edit-decision row. */
export function scoreEdits(rows) {
  return rows.map((r) => {
    const divergence = editDivergence(r.draft_body, r.final_body);
    return { ...r, divergence, severity: severity(divergence) };
  });
}

/**
 * Per-template learning signal over ALL edits (not just the big ones):
 * edit count, major count, avg divergence — sorted by avg divergence desc.
 */
export function summariseByTemplate(scored) {
  const byTemplate = new Map();
  for (const r of scored) {
    const key = r.draft_template ?? NO_TEMPLATE;
    if (!byTemplate.has(key)) byTemplate.set(key, { template: key, edits: 0, major: 0, sum: 0 });
    const s = byTemplate.get(key);
    s.edits += 1;
    s.sum += r.divergence;
    if (r.severity === 'major') s.major += 1;
  }
  return [...byTemplate.values()]
    .map(({ template, edits, major, sum }) => ({ template, edits, major, avgDivergence: sum / edits }))
    .sort((a, b) => b.avgDivergence - a.avgDivergence || a.template.localeCompare(b.template));
}

function blockquote(text) {
  return (text ?? '').split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
}

function fmt(ratio) {
  return ratio.toFixed(2);
}

export function formatReport({ scored, min, dbPath, generatedAt }) {
  const summary = summariseByTemplate(scored);
  const big = scored.filter((r) => r.divergence >= min);

  const lines = [];
  lines.push('# Edit review — stora omskrivningar av bot-utkast');
  lines.push('');
  lines.push(`Genererad: ${generatedAt} · DB: ${dbPath} · tröskel: ≥ ${min}`);
  lines.push(`${scored.length} edit-beslut totalt, varav ${big.length} över tröskeln.`);
  lines.push('');
  lines.push('## Per mall (alla edits — lärandesignalen)');
  lines.push('');
  lines.push('| Template | Edits | Major | Avg divergence |');
  lines.push('|---|---:|---:|---:|');
  for (const s of summary) {
    lines.push(`| ${s.template} | ${s.edits} | ${s.major} | ${fmt(s.avgDivergence)} |`);
  }
  lines.push('');

  if (big.length === 0) {
    lines.push(`_Inga edits ≥ ${min} (no edits above the threshold)._`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Stora omskrivningar per mall');
  lines.push('');
  // Group in summary order (worst template first); sort by divergence desc within.
  for (const s of summary) {
    const group = big
      .filter((r) => (r.draft_template ?? NO_TEMPLATE) === s.template)
      .sort((a, b) => b.divergence - a.divergence);
    if (group.length === 0) continue;
    lines.push(`## ${s.template} (${group.length} ${group.length === 1 ? 'stor edit' : 'stora edits'})`);
    lines.push('');
    for (const r of group) {
      lines.push(`### ${r.kommun_namn} / ${r.role} — ${fmt(r.divergence)} (${r.severity})`);
      lines.push('');
      lines.push(`- classifier: \`${r.classifier_class ?? '—'}\` · state: \`${r.conversation_state}\` · beslutad: ${r.decided_at} · decision #${r.decision_id}`);
      lines.push('');
      lines.push('**BOT DRAFT**');
      lines.push('');
      lines.push(blockquote(r.draft_body));
      lines.push('');
      lines.push('**DU SKICKADE**');
      lines.push('');
      lines.push(blockquote(r.final_body));
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    console.error(`No database at ${args.db} — nothing to review.`);
    process.exitCode = 1;
    return;
  }
  // Read-only usage: no migrate(), SELECT only.
  const db = openDb(args.db);
  try {
    const scored = scoreEdits(db.listEditDecisions());
    const report = formatReport({
      scored,
      min: args.min,
      dbPath: args.db,
      generatedAt: new Date().toISOString(),
    });
    if (args.dryRun) {
      console.log(report);
    } else {
      writeFileSync(args.out, report + '\n');
      console.log(`Wrote ${args.out}: ${scored.length} edit decision(s), ${scored.filter((r) => r.divergence >= args.min).length} ≥ ${args.min}.`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
