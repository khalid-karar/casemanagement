import { createHash } from 'node:crypto';
import { ocrAvailable, ocrImage, ocrPdf, pdfTextLayer } from './ocr';

export class FileError extends Error { constructor(public readonly code: string) { super(code); } }
export const MAX_BYTES = 25 * 1024 * 1024;

export type FileKind = 'pdf' | 'docx' | 'txt' | 'image';
export type Method = 'text-layer' | 'ocr' | 'docx' | 'plain';

/** Decide by content, never by the file name or the browser-supplied type. */
export function sniff(bytes: Uint8Array): FileKind {
  const head = (n: number) => String.fromCharCode(...bytes.slice(0, n));
  if (head(5) === '%PDF-') return 'pdf';
  if (head(2) === 'PK') return 'docx'; // validated further by the parser
  if (head(8) === '\x89PNG\r\n\x1a\n' || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return 'image';
  if (bytes.slice(0, 4096).includes(0)) throw new FileError('UNSUPPORTED_FILE_TYPE');
  return 'txt';
}

export interface ExtractedFile {
  text: string;
  kind: FileKind;
  method: Method;
  sha256: string;
  /** 0-100 for OCR, null otherwise. */
  confidence: number | null;
  /** Always shown to the reviewer; OCR output is never trusted without a human reading it against the original. */
  warnings: string[];
}

const ARABIC = /[؀-ۿﭐ-﷿ﹰ-﻿]/;

/**
 * Text from PDF / Word / image / plain text.
 *  - Word and plain text are read directly (most reliable for Arabic).
 *  - PDFs with Arabic are OCR'd, not read from their text layer: Arabic text layers commonly store letters in
 *    visual order or split lam-alef ligatures ("لا" becomes "ال"), which silently changes the meaning of a law.
 *  - Scans and images are OCR'd. Confidence is reported and low-confidence pages are named.
 */
export async function extractText(bytes: Uint8Array): Promise<ExtractedFile> {
  if (bytes.byteLength === 0) throw new FileError('EMPTY_FILE');
  if (bytes.byteLength > MAX_BYTES) throw new FileError('FILE_TOO_LARGE');
  const kind = sniff(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const warnings: string[] = [];
  let text = '';
  let method: Method = 'plain';
  let confidence: number | null = null;

  const fromOcr = async (fn: () => ReturnType<typeof ocrPdf>) => {
    if (!(await ocrAvailable())) throw new FileError('OCR_NOT_INSTALLED');
    let r;
    try { r = await fn(); } catch (e) {
      if ((e as Error).message === 'TOO_MANY_PAGES') throw new FileError('TOO_MANY_PAGES');
      throw new FileError('UNREADABLE_FILE');
    }
    method = 'ocr';
    confidence = Math.round(r.meanConfidence);
    warnings.push(`OCR_USED: text was read from page images (confidence ${confidence}/100). Check every article against the original before verifying.`);
    if (r.lowConfidencePages.length) warnings.push(`LOW_CONFIDENCE_PAGES: ${r.lowConfidencePages.join(', ')}. Re-scan or correct these by hand.`);
    return r.text;
  };

  try {
    if (kind === 'pdf') {
      let layer = '';
      try { layer = await pdfTextLayer(bytes); } catch { /* fall through to OCR */ }
      if (layer.trim().length >= 20 && !ARABIC.test(layer)) {
        text = layer; method = 'text-layer';
      } else {
        text = await fromOcr(() => ocrPdf(bytes));
      }
    } else if (kind === 'image') {
      text = await fromOcr(() => ocrImage(bytes, bytes[0] === 0xff ? 'jpg' : 'png'));
    } else if (kind === 'docx') {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
      method = 'docx';
    } else {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new FileError('UNREADABLE_FILE');
  }
  text = text.replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < 20) warnings.push('Very little text found. Paste the text manually or upload a clearer file.');
  return { text, kind, method, sha256, confidence, warnings };
}
