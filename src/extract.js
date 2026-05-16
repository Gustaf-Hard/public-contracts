import * as cheerio from 'cheerio';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function deobfuscate(s) {
  return s
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/&#64;/g, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.');
}

export function extractEmails(html, sourceUrl) {
  const $ = cheerio.load(html);

  const fromMailto = $('a[href^="mailto:"]')
    .map((_, el) => {
      const href = $(el).attr('href') ?? '';
      return href.replace(/^mailto:/i, '').split('?')[0];
    })
    .get()
    .filter(Boolean);

  $('script, style, noscript').remove();
  const text = deobfuscate($('body').text());
  const fromText = [...text.matchAll(EMAIL_RE)].map((m) => m[0]);

  const seen = new Set();
  const out = [];
  for (const raw of [...fromMailto, ...fromText]) {
    const email = raw.toLowerCase().trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, source_url: sourceUrl });
  }
  return out;
}
