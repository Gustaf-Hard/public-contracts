import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

// Extract PDF entries from a zip archive buffer. Kommuner sometimes deliver
// contracts as a zipped bundle; we pull each .pdf out so it can be saved and
// analysed like any other attachment. Directory entries and non-PDFs are
// skipped; inner directory components are stripped from the name. Returns []
// on a corrupt / non-zip buffer (never throws — tick safety).
export function extractPdfsFromZip(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return [];
  }
  const out = [];
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue; // directory marker
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    const base = name.split('/').pop();
    out.push({ filename: base, data: Buffer.from(data) });
  }
  return out;
}

// Images smaller than this are almost certainly e-mail signature logos /
// footer icons (typically 1–15 kB), not delivered documents. Anything at or
// above the threshold — a scanned contract photographed as a JPEG easily
// clears it — is kept. Noise control only; when in doubt we store.
export const TINY_IMAGE_SKIP_BYTES = 20 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i;

// True only for an image KNOWN to be below TINY_IMAGE_SKIP_BYTES. Non-images
// are never trivial regardless of size (a 900-byte .xlsx is still a delivered
// document), and an image with unknown size (0/undefined) is kept — the
// default is to store anything that could be a document.
export function isTrivialImage({ filename, mime_type, size_bytes } = {}) {
  const isImage = (mime_type ?? '').toLowerCase().startsWith('image/')
    || IMAGE_EXT_RE.test(filename ?? '');
  if (!isImage) return false;
  const size = size_bytes ?? 0;
  return size > 0 && size < TINY_IMAGE_SKIP_BYTES;
}

// De-duplicate filenames within one message. Two same-named PDFs (e.g. zip
// subfolders a/avtal.pdf and b/avtal.pdf that both flatten to avtal.pdf)
// would otherwise overwrite the same saved path, leaving two DB rows pointing
// at one file. Second and later occurrences get " (2)", " (3)"… before the
// extension. Case-insensitive, since the saved filesystem may be.
export function dedupeFilenames(entries) {
  const used = new Map();
  return entries.map((e) => {
    const name = e.filename || 'attachment';
    const key = name.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n === 1) return e;
    const dot = name.lastIndexOf('.');
    const renamed = dot > 0
      ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
      : `${name} (${n})`;
    return { ...e, filename: renamed };
  });
}

export function safeFilename(name) {
  // First, replace path separators with underscores
  let safe = name.replace(/[/\\]+/g, '_');
  // Remove sequences of dots (like .. which can traverse directories)
  safe = safe.replace(/\.{2,}/g, '_');
  // Sanitize all special characters except . - _
  safe = safe.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Remove leading underscores
  safe = safe.replace(/^_+/, '');

  if (safe.length <= 120) return safe;
  const dot = safe.lastIndexOf('.');
  if (dot === -1) return safe.slice(0, 120);
  const ext = safe.slice(dot);
  return safe.slice(0, 120 - ext.length) + ext;
}

export async function saveAttachment(buffer, metadata, { baseDir }) {
  const dir = join(baseDir, metadata.kommun_kod);
  mkdirSync(dir, { recursive: true });
  const date = metadata.received_at.slice(0, 10);
  const safeName = safeFilename(metadata.original_filename);
  const filename = `${date}__${metadata.gmail_message_id}__${safeName}`;
  const savedPath = join(dir, filename);
  writeFileSync(savedPath, buffer);

  const meta = {
    kommun_kod: metadata.kommun_kod,
    kommun_namn: metadata.kommun_namn,
    role: metadata.role,
    received_at: metadata.received_at,
    from_email: metadata.from_email,
    from_name: metadata.from_name ?? null,
    gmail_message_id: metadata.gmail_message_id,
    gmail_thread_id: metadata.gmail_thread_id,
    subject: metadata.subject,
    original_filename: metadata.original_filename,
    mime_type: metadata.mime_type,
    size_bytes: buffer.length,
  };
  writeFileSync(savedPath + '.meta.json', JSON.stringify(meta, null, 2));

  return { saved_path: savedPath, size_bytes: buffer.length };
}
