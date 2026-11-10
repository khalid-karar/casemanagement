import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** External tools: poppler-utils (pdftotext, pdftoppm) and tesseract-ocr with the `ara` language pack. */
export async function ocrAvailable(): Promise<boolean> {
  try {
    await run('tesseract', ['--list-langs'], { timeout: 10_000 }).then((r) => {
      if (!/\bara\b/.test(`${r.stdout}${r.stderr}`)) throw new Error('no ara');
    });
    await run('pdftoppm', ['-v'], { timeout: 10_000 }).catch((e) => { if (e.code === 'ENOENT') throw e; });
    return true;
  } catch {
    return false;
  }
}

export interface OcrResult { text: string; pages: number; meanConfidence: number; lowConfidencePages: number[] }

const MAX_PAGES = 300;
const CONF_WARN = 80;

/** Mean of word confidences (0-100) from tesseract TSV, ignoring non-word rows. */
export function parseConfidence(tsv: string): number {
  const rows = tsv.split('\n').slice(1).map((l) => l.split('\t'));
  const confs = rows.filter((c) => c[0] === '5' && c[11]?.trim()).map((c) => Number(c[10])).filter((n) => n >= 0);
  return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
}

async function ocrImages(dir: string, files: string[]): Promise<OcrResult> {
  const texts: string[] = [];
  const confs: number[] = [];
  const low: number[] = [];
  for (const [i, f] of files.entries()) {
    const base = join(dir, `o${i}`);
    // Pages run one at a time: OCR is CPU heavy and a large upload must not starve the API.
    await run('tesseract', [join(dir, f), base, '-l', 'ara+eng', 'txt', 'tsv'], { timeout: 120_000 });
    texts.push((await readFile(`${base}.txt`, 'utf8')).trim());
    const c = parseConfidence(await readFile(`${base}.tsv`, 'utf8'));
    confs.push(c);
    if (c < CONF_WARN) low.push(i + 1);
  }
  return { text: texts.join('\n\n'), pages: files.length, meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0, lowConfidencePages: low };
}

/** OCR a PDF: render each page to an image, then read it. No shell is involved; arguments are never interpreted. */
export async function ocrPdf(bytes: Uint8Array): Promise<OcrResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    await writeFile(join(dir, 'in.pdf'), bytes);
    const info = await run('pdfinfo', [join(dir, 'in.pdf')], { timeout: 20_000 }).catch(() => ({ stdout: '' }));
    const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? 0);
    if (pages > MAX_PAGES) throw new Error('TOO_MANY_PAGES');
    // Scans can declare any physical page size; render to a fixed pixel width (~A4 at 300 dpi) so OCR sees consistent text size.
    const wPts = Number(/Page size:\s+([\d.]+)\s+x/.exec(info.stdout)?.[1] ?? 595);
    const dpi = Math.min(400, Math.max(100, Math.round(2480 / (wPts / 72))));
    await run('pdftoppm', ['-r', String(dpi), '-gray', '-png', join(dir, 'in.pdf'), join(dir, 'p')], { timeout: 300_000 });
    const files = (await readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort();
    if (files.length === 0) throw new Error('NO_PAGES');
    return await ocrImages(dir, files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function ocrImage(bytes: Uint8Array, ext: 'png' | 'jpg'): Promise<OcrResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    await writeFile(join(dir, `i.${ext}`), bytes);
    return await ocrImages(dir, [`i.${ext}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function pdfTextLayer(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'txt-'));
  try {
    await writeFile(join(dir, 'in.pdf'), bytes);
    const r = await run('pdftotext', ['-enc', 'UTF-8', join(dir, 'in.pdf'), '-'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return r.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
