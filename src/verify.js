import { resolveMx } from 'node:dns/promises';

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function isValidEmailSyntax(email) {
  return EMAIL_RE.test(email ?? '');
}

export async function hasMxRecord(domain) {
  try {
    const recs = await resolveMx(domain);
    return recs.length > 0;
  } catch {
    return false;
  }
}

export async function verifyAll(records, { checkMx = hasMxRecord } = {}) {
  const invalidSyntax = [];
  const missingMx = [];

  const allEmails = records.flatMap((r) =>
    r.contacts.map((c) => ({ kommun: r.kommun_namn, kod: r.kommun_kod, ...c }))
  );

  for (const c of allEmails) {
    if (!isValidEmailSyntax(c.email)) invalidSyntax.push(c);
  }

  const domains = [...new Set(
    allEmails.filter((c) => isValidEmailSyntax(c.email)).map((c) => c.email.split('@')[1])
  )];
  const mxCache = new Map();
  for (const d of domains) mxCache.set(d, await checkMx(d));

  for (const c of allEmails) {
    if (!isValidEmailSyntax(c.email)) continue;
    const domain = c.email.split('@')[1];
    if (!mxCache.get(domain)) missingMx.push({ ...c, domain });
  }

  return { invalidSyntax, missingMx };
}

export function buildReviewReport(records) {
  const lines = [];
  lines.push(`Review report — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  const flagged = records.filter((r) => r.confidence !== 'high');
  lines.push(`Kommuner needing review: ${flagged.length}`);
  lines.push('');
  for (const r of flagged) {
    lines.push(`## ${r.kommun_namn} (${r.confidence}) — ${r.kommun_kod}`);
    lines.push(`  Website: ${r.webbplats ?? '(none)'}`);
    if (r.notes) lines.push(`  Notes: ${r.notes}`);
    if (r.contacts.length === 0) {
      lines.push('  No contacts found.');
    } else {
      lines.push('  Found:');
      for (const c of r.contacts) {
        lines.push(`    - ${c.email}  [${c.role}]  ${c.source_url}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
