import * as cheerio from 'cheerio';
import { politeFetch } from './http.js';
import { extractEmails } from './extract.js';
import { classifyRole } from './classify.js';
import { computeConfidence } from './confidence.js';

const ANCHOR_KEYWORDS_RE =
  /(kontakt|förvaltning|forvaltning|nämnd|namnd|registrator|diarium|organisation|upphandling|insyn|rattssakerhet|rättssäkerhet|sekretess|allmanna-handlingar|allmänna-handlingar)/i;

// Common fixed paths to probe on every municipality website.
// These are tried after crawling discovered links and won't count toward MAX_PAGES_PER_KOMMUN.
const PROBE_PATHS = [
  '/kontakt',
  '/kontakta-oss',
  '/kontakta-kommunen',
  '/om-kommunen/kontakt',
  '/om-kommunen/kontakta-oss',
  '/registrator',
  '/diarium',
  '/forvaltning',
  '/forvaltningar',
  '/kommunens-forvaltningar',
  '/kommunens-organisation',
  '/kontakt/registrator',
  '/dina-rattigheter/begara-ut-handlingar',
  '/offentlig-handling',
  '/allmanna-handlingar',
];

const MAX_PAGES_PER_KOMMUN = 20;

// Swedish words and common suffixes that appear after a period but aren't TLDs
const FALSE_TLD_RE = /^(du|kan|om|att|vi|ni|de|en|ett|se\.du|setelefon|sebes|seorg|seskriv|skol|besök|telefon|adress|org|be|bes|skr)/i;

// Known functional/role words that appear in email local parts (not personal names)
const FUNCTIONAL_EMAIL_WORDS = new Set([
  'info', 'kontakt', 'registrator', 'diarium', 'kansli', 'kommun', 'kommunen',
  'bun', 'buf', 'vux', 'it', 'upphandling', 'ks', 'kf', 'forvaltningen',
  'forvaltning', 'namnd', 'servicecenter', 'medborgar', 'arkiv', 'stab',
  'utbildning', 'skola', 'gymnasie', 'barn', 'och', 'digital', 'ledning',
  'center', 'direkt', 'torget', 'service', 'support', 'helpdesk', 'drift',
  'ekonomi', 'hr', 'personal', 'juridik', 'miljo', 'plan', 'bygg',
]);

export function isPersonalEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  // Must contain exactly one dot to match firstname.lastname pattern
  const dotParts = local.split('.');
  if (dotParts.length !== 2) return false;
  const [first, last] = dotParts;
  // Each part must be 2-20 characters, letters and hyphens only
  if (!/^[a-z-]{2,20}$/.test(first) || !/^[a-z-]{2,20}$/.test(last)) return false;
  // Neither part should be a known functional/role word
  if (FUNCTIONAL_EMAIL_WORDS.has(first) || FUNCTIONAL_EMAIL_WORDS.has(last)) return false;
  return true;
}

export function isValidEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!domain) return false;
  // Domain must be valid hostname-like
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/i.test(domain)) return false;
  const segments = domain.split('.');
  if (segments.length < 2) return false;
  const tld = segments[segments.length - 1];
  // TLD should be 2-6 characters (covers .se, .com, .nu, .org, .info, etc.)
  if (tld.length < 2 || tld.length > 6) return false;
  // Reject if TLD matches a known false pattern (Swedish word after sentence)
  if (FALSE_TLD_RE.test(tld)) return false;
  // Reject if second-to-last segment + TLD forms a known-garbled pattern
  if (segments.length >= 3) {
    const combined = segments.slice(-2).join('.');
    if (FALSE_TLD_RE.test(combined)) return false;
  }
  // Reject if local part looks garbled (leading zeros like "00kommunen")
  if (/^0+[a-z]/i.test(local)) return false;
  return true;
}

export function findCandidateLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text();
    if (!href) return;
    let absolute;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      return;
    }
    const u = new URL(absolute);
    if (u.host !== base.host) return;
    if (!/^https?:$/.test(u.protocol)) return;
    const matches =
      ANCHOR_KEYWORDS_RE.test(u.pathname) || ANCHOR_KEYWORDS_RE.test(text);
    if (!matches) return;
    const norm = absolute.split('#')[0];
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  });
  return out;
}

function pageContext(html, url) {
  const $ = cheerio.load(html);
  return {
    url,
    pageTitle: $('title').first().text().trim(),
    headings: $('h1,h2,h3').map((_, el) => $(el).text().trim()).get().slice(0, 10),
  };
}

function forvaltningNameFromHeadings(headings) {
  const h = headings.find((s) => /förvaltning|nämnd/i.test(s));
  return h ?? null;
}

function shouldKeepContact(email, role) {
  if (role !== 'other') return true;
  // Keep emails whose local part indicates a relevant role
  const local = email.split('@')[0].toLowerCase();
  // Match prefixes or anywhere in local part (handles "arboga.kommun@" or "vasteras.registrator@")
  if (/^(registrator|kommun|info|kontakt|diariet|diarium|bun|buf|skol|utbildning|gymnasie|vux|it|upphandling|kansli|stadskansliet|kommunledning|kommunstyrel|namnden|namnd|forvaltning|forvaltningen|servicecenter|medborgar|arkiv)/i.test(local)) return true;
  // Also match if local part ends with or contains keyword after a dot/hyphen
  if (/[._-](registrator|kommun|info|kontakt|diarium|kansli|kommunledning|utbildning|forvaltning)/i.test(local)) return true;
  // Match "cityname+stad@" pattern (e.g. "malmostad@malmo.se", "gbgstad@goteborg.se")
  if (/stad@/i.test(email)) return true;
  return false;
}

export async function crawlKommun(seed, { fetch = (u, o) => politeFetch(u, o), today } = {}) {
  const baseRecord = {
    kommun_kod: seed.kommun_kod,
    kommun_namn: seed.kommun_namn,
    lan: seed.lan,
    org_nr: seed.org_nr ?? null,
    webbplats: seed.webbplats ?? null,
    diarium_url: null,
    contacts: [],
    confidence: 'low',
    notes: null,
    verified_at: today ?? new Date().toISOString().slice(0, 10),
  };

  if (!seed.webbplats) {
    baseRecord.notes = 'no website in seed';
    return baseRecord;
  }

  // Normalise: ensure homepage URL ends with '/' so URL resolution works correctly
  const homeUrl = seed.webbplats.replace(/\/?$/, '/');
  const baseOrigin = new URL(homeUrl).origin;

  let homeRes;
  try {
    homeRes = await fetch(homeUrl);
  } catch (e) {
    baseRecord.notes = `homepage fetch failed: ${e.message}`;
    return baseRecord;
  }
  if (!homeRes.ok) {
    baseRecord.notes = `homepage status ${homeRes.status}`;
    return baseRecord;
  }
  const homeHtml = await homeRes.text();

  // Collect candidate URLs: first from homepage links, then probes
  const fromHome = findCandidateLinks(homeHtml, homeUrl);
  const probedUrls = PROBE_PATHS.map((p) => baseOrigin + p);

  // Deduplicate and limit
  const seenUrls = new Set([homeUrl]);
  const candidateUrls = [];
  for (const u of [...fromHome, ...probedUrls]) {
    const norm = u.split('#')[0];
    if (seenUrls.has(norm)) continue;
    seenUrls.add(norm);
    candidateUrls.push(norm);
    if (candidateUrls.length >= MAX_PAGES_PER_KOMMUN) break;
  }

  const pages = [{ url: homeUrl, html: homeHtml }];
  for (const url of candidateUrls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const html = await r.text();
      pages.push({ url, html });

      // One level deeper: collect sub-links from this page and add any new candidates
      if (pages.length < MAX_PAGES_PER_KOMMUN + 5) {
        const subLinks = findCandidateLinks(html, url);
        for (const sub of subLinks) {
          const norm = sub.split('#')[0];
          if (seenUrls.has(norm)) continue;
          seenUrls.add(norm);
          try {
            const sr = await fetch(norm);
            if (!sr.ok) continue;
            pages.push({ url: norm, html: await sr.text() });
          } catch {
            // tolerate
          }
          if (pages.length >= MAX_PAGES_PER_KOMMUN + 5) break;
        }
      }
    } catch {
      // tolerate per-page failures
    }
  }

  // Determine the expected email domain (e.g. "vasteras.se" from "www.vasteras.se")
  const homeDomain = new URL(homeUrl).hostname.replace(/^www\./, '');

  const seenEmails = new Set();
  for (const { url, html } of pages) {
    let emails, ctx;
    try {
      emails = extractEmails(html, url);
      ctx = pageContext(html, url);
    } catch {
      // Skip pages that cause parsing errors (e.g. deeply nested DOM causing stack overflow)
      continue;
    }
    for (const { email, source_url } of emails) {
      if (!isValidEmail(email)) continue;
      if (isPersonalEmail(email)) continue;
      // Filter out cross-domain emails (e.g. arvika.se emails on eda.se pages)
      const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
      if (emailDomain !== homeDomain && !emailDomain.endsWith('.' + homeDomain)) continue;
      if (seenEmails.has(email)) continue;
      seenEmails.add(email);
      const role = classifyRole({ ...ctx, email });
      if (!shouldKeepContact(email, role)) continue;
      baseRecord.contacts.push({
        email,
        role,
        forvaltning_namn: forvaltningNameFromHeadings(ctx.headings),
        source_url,
        found_via: emails.length === 1 ? 'pattern_match' : 'contact_page',
      });
    }
  }

  baseRecord.confidence = computeConfidence(baseRecord.contacts);
  return baseRecord;
}
