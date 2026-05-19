import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
