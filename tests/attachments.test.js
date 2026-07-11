import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { saveAttachment, safeFilename, extractPdfsFromZip, isTrivialImage, TINY_IMAGE_SKIP_BYTES } from '../src/attachments.js';

describe('isTrivialImage', () => {
  it('flags a small inline-signature-sized image', () => {
    expect(isTrivialImage({ filename: 'image001.png', mime_type: 'image/png', size_bytes: 4_096 })).toBe(true);
    expect(isTrivialImage({ filename: 'logo.jpg', mime_type: 'image/jpeg', size_bytes: TINY_IMAGE_SKIP_BYTES - 1 })).toBe(true);
  });

  it('keeps images at or above the threshold — could be a scanned document', () => {
    expect(isTrivialImage({ filename: 'scan.png', mime_type: 'image/png', size_bytes: TINY_IMAGE_SKIP_BYTES })).toBe(false);
    expect(isTrivialImage({ filename: 'avtal-scan.jpg', mime_type: 'image/jpeg', size_bytes: 900_000 })).toBe(false);
  });

  it('detects images by filename extension when the mime type is generic', () => {
    expect(isTrivialImage({ filename: 'image001.gif', mime_type: 'application/octet-stream', size_bytes: 1_000 })).toBe(true);
  });

  it('never flags non-image documents, however small', () => {
    expect(isTrivialImage({ filename: 'sammanställning.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 900 })).toBe(false);
    expect(isTrivialImage({ filename: 'svar.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: 500 })).toBe(false);
    expect(isTrivialImage({ filename: 'avtal.pdf', mime_type: 'application/pdf', size_bytes: 100 })).toBe(false);
  });

  it('keeps an image whose size is unknown (0/undefined counts as unknown → keep)', () => {
    expect(isTrivialImage({ filename: 'bild.png', mime_type: 'image/png', size_bytes: 0 })).toBe(false);
    expect(isTrivialImage({ filename: 'bild.png', mime_type: 'image/png' })).toBe(false);
  });
});

describe('extractPdfsFromZip', () => {
  it('returns only PDF entries, basenamed, with their bytes', () => {
    const zip = zipSync({
      'Avtal.pdf': strToU8('%PDF-1.4 first'),
      'läs-mig.txt': strToU8('inte ett avtal'),
      'bilagor/Pris.pdf': strToU8('%PDF-1.4 nested'),
    });
    const pdfs = extractPdfsFromZip(Buffer.from(zip));
    expect(pdfs.map((p) => p.filename).sort()).toEqual(['Avtal.pdf', 'Pris.pdf']);
    const avtal = pdfs.find((p) => p.filename === 'Avtal.pdf');
    expect(avtal.data.toString()).toBe('%PDF-1.4 first');
  });

  it('skips directory entries and is case-insensitive on .pdf', () => {
    const zip = zipSync({ 'DIR/': strToU8(''), 'X.PDF': strToU8('%PDF-1.4') });
    const pdfs = extractPdfsFromZip(Buffer.from(zip));
    expect(pdfs.map((p) => p.filename)).toEqual(['X.PDF']);
  });

  it('returns [] on a corrupt / non-zip buffer', () => {
    expect(extractPdfsFromZip(Buffer.from('not a zip at all'))).toEqual([]);
  });
});

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pilot-att-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('safeFilename', () => {
  it('strips path separators and special chars', () => {
    expect(safeFilename('../../../etc/passwd')).toBe('etc_passwd');
    expect(safeFilename('My Avtal (slutligt).pdf')).toBe('My_Avtal_slutligt_.pdf');
  });

  it('truncates very long names', () => {
    const long = 'a'.repeat(300) + '.pdf';
    expect(safeFilename(long).length).toBeLessThanOrEqual(120);
  });
});

describe('saveAttachment', () => {
  it('saves the file and writes a .meta.json sidecar', async () => {
    const metadata = {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      received_at: '2026-05-19T10:00:00Z',
      from_email: 'a@x.se',
      from_name: 'Registrator',
      gmail_message_id: 'msg-1',
      gmail_thread_id: 'thr-1',
      subject: 'Re: Begäran',
      original_filename: 'avtal Skolon.pdf',
      mime_type: 'application/pdf',
    };
    const result = await saveAttachment(Buffer.from('%PDF-1.4 fake'), metadata, { baseDir: tmp });
    expect(existsSync(result.saved_path)).toBe(true);
    const meta = JSON.parse(readFileSync(result.saved_path + '.meta.json', 'utf8'));
    expect(meta.kommun_kod).toBe('9999');
    expect(meta.original_filename).toBe('avtal Skolon.pdf');
    expect(result.saved_path).toContain('9999');
    expect(result.saved_path).toContain('avtal_Skolon.pdf');
  });

  it('creates the kommun directory if missing', async () => {
    const result = await saveAttachment(Buffer.from('x'), {
      kommun_kod: '2418',
      kommun_namn: 'Malå',
      role: 'central',
      received_at: '2026-05-19T10:00:00Z',
      from_email: 'a@x.se',
      gmail_message_id: 'mX',
      gmail_thread_id: 'tX',
      subject: 's',
      original_filename: 'doc.pdf',
      mime_type: 'application/pdf',
    }, { baseDir: tmp });
    expect(existsSync(join(tmp, '2418'))).toBe(true);
    expect(existsSync(result.saved_path)).toBe(true);
  });
});
