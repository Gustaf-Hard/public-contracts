// Pure edit-divergence scoring for operator edits of bot drafts.
// Resurrects deferred review finding M3: measure how far the sent text
// diverged from the drafted text so the big rewrites can be surfaced and
// fed back into templates/prompts/classifier. No IO here — see
// scripts/08-review-edits.js for the on-demand report.

/**
 * Plain Levenshtein distance. Hand-written two-row DP — the bodies we
 * compare are short emails, so no dependency is warranted.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Normalized edit distance between a bot draft and the text the operator
 * actually sent: 0 = identical, 1 = total rewrite.
 * distance / max(len(draft), len(final)); two empties → 0, one empty → 1.
 */
export function editDivergence(draft, final) {
  const a = draft ?? '';
  const b = final ?? '';
  if (a === '' && b === '') return 0;
  if (a === '' || b === '') return 1;
  return levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Bucket a divergence ratio for reporting:
 * trivial (<0.15) | moderate (0.15–<0.4) | major (≥0.4).
 */
export function severity(ratio) {
  if (ratio < 0.15) return 'trivial';
  if (ratio < 0.4) return 'moderate';
  return 'major';
}
