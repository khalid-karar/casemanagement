import { FileError, MAX_BYTES, sniff } from '../legal/files';
import { createHash } from 'node:crypto';

/** Artifact types are identifiers, not free text. */
export const ARTIFACT_TYPE = /^[a-z][a-z0-9_]{1,63}$/;

export interface Described { sha256: string; mime: string; size: number; kind: 'pdf' | 'docx' | 'txt' | 'image' }

/**
 * What a document is is decided from its bytes, never from the file name or the browser's content type.
 * The stored mime comes from here, so a download cannot be served as something else (no HTML, no script).
 */
export function describeUpload(bytes: Uint8Array): Described {
  if (bytes.byteLength === 0) throw new FileError('EMPTY_FILE');
  if (bytes.byteLength > MAX_BYTES) throw new FileError('FILE_TOO_LARGE');
  const kind = sniff(bytes); // throws UNSUPPORTED_FILE_TYPE for binaries we do not accept
  const mime =
    kind === 'pdf' ? 'application/pdf'
    : kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : kind === 'image' ? (bytes[0] === 0xff ? 'image/jpeg' : 'image/png')
    : 'text/plain; charset=utf-8';
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mime, size: bytes.byteLength, kind };
}

/** Stored names are display text only: strip paths and control characters, cap the length. */
export const safeName = (n: string) => n.replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 200) || 'document';
