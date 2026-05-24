// Heuristic Swedish email signature extractor.
// Scans the body for a "Med vänlig hälsning" / "MVH" marker, takes the lines
// that follow, and pulls out name / title / förvaltning / phone / email /
// postal / website using language-aware patterns.
//
// Returns null when no signature marker is detected. Individual fields are
// null when they couldn't be extracted with confidence.

const SIGNATURE_MARKERS = [
  /^[ \t>]*Med vänlig(?:a)? hälsning(?:ar)?[\s,.\-!]*$/im,
  /^[ \t>]*M\.?\s?V\.?\s?H\.?[\s,.\-!]*$/im,
  /^[ \t>]*Vänligen[\s,.\-!]*$/im,
  /^[ \t>]*Hälsning(?:ar)?[\s,.\-!]*$/im,
  /^[ \t>]*Bästa hälsning(?:ar)?[\s,.\-!]*$/im,
];

const EMAIL_RE = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/;
const PHONE_RE = /\b(0\d{1,3}[-\s]?\d[\d\s-]{4,12})\b/;
const POSTAL_RE = /\b(\d{3}\s?\d{2})\s+([A-ZÅÄÖ][a-zåäö]+(?:[-\s][A-ZÅÄÖ][a-zåäö]+)?)\b/;
const WEBSITE_RE = /\b((?:https?:\/\/|www\.)[^\s,;<>"]+)/i;

// Pure name line: 2–4 Swedish-capitalised words, optionally with "af/von/de/av/och" connectors.
// Note: includes accented chars via the \p{Lu}\p{Ll} categories via inline ranges.
const NAME_LINE_RE = /^([A-ZÅÄÖ][a-zåäö'-]+)(?:\s+(?:af|von|de|av|och|der|den)\s+|\s+)(?:[A-ZÅÄÖ][a-zåäö'-]+(?:\s+(?:af|von|de|av|och|der|den)\s+|\s+)){0,3}[A-ZÅÄÖ][a-zåäö'-]+$/;

// Words that strongly indicate a job title rather than a name or address.
const TITLE_KEYWORDS = /(chef|ansvarig|rektor|sekreterare|administratör|administrator|samordnare|registrator|utveckling|enhets|inköp|upphandling|expert|strateg|controller|jurist|rådgivare|handläggare|koordinator|specialist|direktör|tjänsteman|biträde|kansli|ekonom)/i;

// Words/patterns that indicate a förvaltning or nämnd line.
const FORVALTNING_KEYWORDS = /förvaltning|nämnd|kontoret|skolan|gymnasi|avdelning|enhet[^s]/i;

// Common phrases that aren't address/title — used to skip when scanning.
const NOISE_LINES = /^(adress|telefon|tel|tlf|mobil|e-?post|epost|email|webb|hemsida|fax|org\.?nr)\s*[:.]?\s*$/i;

function lineLooksLikeName(line) {
  if (line.length < 4 || line.length > 80) return false;
  if (/[@:0-9]/.test(line)) return false;
  if (TITLE_KEYWORDS.test(line)) return false;
  if (FORVALTNING_KEYWORDS.test(line)) return false;
  return NAME_LINE_RE.test(line);
}

function findSignatureStart(body) {
  const lines = body.split(/\r?\n/);
  // Iterate top-to-bottom but keep the LAST hit — signatures live at the end
  let lastHit = null;
  for (let i = 0; i < lines.length; i++) {
    for (const re of SIGNATURE_MARKERS) {
      if (re.test(lines[i])) {
        lastHit = i;
        break;
      }
    }
  }
  return lastHit;
}

function stripLabel(line) {
  // "E-post: x@y.se" → "x@y.se"; "Telefon: 070-..." → "070-..."
  return line.replace(/^\s*(e-?post|epost|email|telefon|tel|tlf|mobil|fax|webb|hemsida|adress)\s*[:.]\s*/i, '');
}

export function extractSignature(body) {
  if (!body || typeof body !== 'string') return null;

  const sigStart = findSignatureStart(body);
  if (sigStart === null) return null;

  const lines = body.split(/\r?\n/);
  // Take up to 20 lines after the marker — covers verbose signatures with
  // address blocks, social links, etc., without dragging in next-quoted-reply.
  const rawSig = lines.slice(sigStart + 1, sigStart + 21);
  const trimmed = rawSig.map((l) => l.trim()).filter(Boolean);
  if (trimmed.length === 0) return null;

  const signatureBlock = rawSig.join('\n').replace(/\s+$/g, '');

  // --- Name ---
  let name = null;
  let nameIdx = -1;
  for (let i = 0; i < Math.min(trimmed.length, 6); i++) {
    if (lineLooksLikeName(trimmed[i])) {
      name = trimmed[i];
      nameIdx = i;
      break;
    }
  }

  // --- Title (job role) ---
  let title = null;
  // 1. Prefer the line directly after the name when it contains a title keyword
  if (nameIdx !== -1 && nameIdx + 1 < trimmed.length) {
    const candidate = trimmed[nameIdx + 1];
    if (TITLE_KEYWORDS.test(candidate) && !FORVALTNING_KEYWORDS.test(candidate) && !/[@0-9]/.test(candidate)) {
      title = candidate;
    }
  }
  // 2. Otherwise scan whole signature for a keyword-matched title
  if (!title) {
    for (const l of trimmed) {
      if (TITLE_KEYWORDS.test(l) && !FORVALTNING_KEYWORDS.test(l) && !/[@0-9]/.test(l) && !NOISE_LINES.test(l)) {
        title = l;
        break;
      }
    }
  }
  // 3. Fallback: the line right after the name, if it looks plausibly title-shaped
  //    (short, no @ / digits / forvaltning, doesn't look like a second name).
  if (!title && nameIdx !== -1 && nameIdx + 1 < trimmed.length) {
    const candidate = trimmed[nameIdx + 1];
    if (
      candidate.length > 2 && candidate.length < 80
      && !/[@0-9]/.test(candidate)
      && !FORVALTNING_KEYWORDS.test(candidate)
      && !lineLooksLikeName(candidate)
      && !NOISE_LINES.test(candidate)
    ) {
      title = candidate;
    }
  }

  // --- Förvaltning / nämnd ---
  let forvaltning = null;
  for (const l of trimmed) {
    if (FORVALTNING_KEYWORDS.test(l) && !/[@0-9]/.test(l) && !NOISE_LINES.test(l)) {
      forvaltning = l;
      break;
    }
  }

  // --- Email ---
  let email = null;
  for (const l of trimmed) {
    const m = stripLabel(l).match(EMAIL_RE);
    if (m) {
      email = m[1].toLowerCase();
      break;
    }
  }

  // --- Phone ---
  let phone = null;
  for (const l of trimmed) {
    const stripped = stripLabel(l);
    const m = stripped.match(PHONE_RE);
    if (m) {
      // Normalise whitespace runs to single space
      phone = m[1].replace(/\s+/g, ' ').trim();
      break;
    }
  }

  // --- Postal ---
  let postal = null;
  for (const l of trimmed) {
    const m = stripLabel(l).match(POSTAL_RE);
    if (m) {
      postal = `${m[1].replace(/\s+/g, ' ')} ${m[2]}`;
      break;
    }
  }

  // --- Website ---
  let website = null;
  for (const l of trimmed) {
    const m = stripLabel(l).match(WEBSITE_RE);
    if (m) {
      website = m[1].replace(/[.,;:]+$/, '');
      break;
    }
  }

  return {
    signature_block: signatureBlock,
    name,
    title,
    forvaltning,
    email,
    phone,
    postal,
    website,
  };
}
