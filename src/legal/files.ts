import { createHash } from 'node:crypto';

export class FileError extends Error { constructor(public readonly code: string) { super(code); } }
export const MAX_BYTES = 15 * 1024 * 1024;

export type FileKind = 'pdf' | 'docx' | 'txt';

/** Decide by content, never by the file name or the browser-supplied type. */
export function sniff(bytes: Uint8Array): FileKind {
  const head = (n: number) => String.fromCharCode(...bytes.slice(0, n));
  if (head(5) === '%PDF-') return 'pdf';
  if (head(2) === 'PK') return 'docx'; // validated further by the parser
  if (bytes.slice(0, 4096).includes(0)) throw new FileError('UNSUPPORTED_FILE_TYPE');
  return 'txt';
}

export interface ExtractedFile { text: string; kind: FileKind; sha256: string; warnings: string[] }

/**
 * Text from PDF / Word / plain text. PDFs of Arabic law often extract with broken letter order or
 * missing text (scans), so the result is only a starting point: the reviewer verifies it against the
 * original file, whose hash is kept.
 */
export async function extractText(bytes: Uint8Array): Promise<ExtractedFile> {
  if (bytes.byteLength === 0) throw new FileError('EMPTY_FILE');
  if (bytes.byteLength > MAX_BYTES) throw new FileError('FILE_TOO_LARGE');
  const kind = sniff(bytes);
  const warnings: string[] = [];
  let text = '';
  try {
    if (kind === 'pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const r = await pdfText(pdf, { mergePages: true });
      text = Array.isArray(r.text) ? r.text.join('\n') : r.text;
    } else if (kind === 'docx') {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } else {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch {
    throw new FileError('UNREADABLE_FILE');
  }
  text = text.replace(/‏|‎/g, '').trim();
  if (text.length < 20) warnings.push('Very little text found: the file may be a scan. OCR is not enabled; paste the text manually.');
  if (kind === 'pdf' && /[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) {
    // Presentation-form glyphs mean the PDF stores visual (reversed) order: letters come out backwards.
    text = text.normalize('NFKC');
    warnings.push('ARABIC_PDF_UNRELIABLE: this PDF stores Arabic in visual order, so the extracted text is likely reversed. Use the Word or text version of the law, or paste it.');
  } else if (kind === 'pdf') warnings.push('PDF text order may be wrong for Arabic: compare with the original before verifying.');
  return { text, kind, sha256: createHash('sha256').update(bytes).digest('hex'), warnings };
}
