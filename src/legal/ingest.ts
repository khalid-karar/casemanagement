import { sha256Hex } from '../engine/canonical';
import type { Provision } from './types';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const normalizeDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

/**
 * Splits raw law text into articles. Understands Arabic ("المادة الحادية والسبعون" is NOT parsed;
 * numeric forms "المادة 71" / "المادة (71)" / "المادة ٧١" and English "Article 71" are) so output
 * is a DRAFT for human verification, never trusted blindly. Text before the first article is dropped
 * into a warning so the reviewer sees it.
 */
export function splitArticles(raw: string): { provisions: Provision[]; warnings: string[] } {
  const text = normalizeDigits(raw.replace(/\r/g, ''));
  const re = /^\s*(?:المادة|مادة|Article)\s*[(\[]?\s*(\d+(?:\s*(?:مكرر\w*|bis))?)\s*[)\]]?\s*[:\-–.]?\s*$/gimu;
  const marks: Array<{ number: string; start: number; end: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ number: (m[1] ?? '').replace(/\s+/g, ' ').trim(), start: m.index, end: m.index + m[0].length });
  }
  const warnings: string[] = [];
  if (marks.length === 0) return { provisions: [], warnings: ['No article headings found; split manually'] };
  if (text.slice(0, marks[0]!.start).trim()) warnings.push('Text before first article was not assigned to any provision');
  const provisions: Provision[] = [];
  const seen = new Set<string>();
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, marks[i + 1]?.start ?? text.length).trim();
    if (seen.has(mk.number)) warnings.push(`Duplicate article number ${mk.number}`);
    seen.add(mk.number);
    if (!body) warnings.push(`Article ${mk.number} is empty`);
    provisions.push({ number: mk.number, textAr: body });
  });
  return { provisions, warnings };
}

export const provisionHash = (p: Provision) => sha256Hex(`${p.number}\n${p.textAr}\n${p.textEn ?? ''}`);
export const sourceHash = (raw: string) => sha256Hex(raw);
