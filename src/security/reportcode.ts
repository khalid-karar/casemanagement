import { createHash, randomBytes } from 'node:crypto';

/**
 * Reference codes for anonymous reports.
 *
 * A reporter who never signs in proves "this is my report" with one thing only: a code shown to them once.
 * So the code IS the credential, and it is treated like a password:
 *   - 120 bits from the OS random source, so guessing is not a realistic attack, only an annoying one;
 *   - only a SHA-256 of it is stored, so a database read cannot be turned into access to anyone's thread;
 *   - it is never logged and never returned by any staff route.
 *
 * The alphabet is Crockford base32 (no I, L, O, U): what a person copies off a phone screen, writes on
 * paper or reads aloud is hard to get wrong. The input parser is forgiving about exactly the mistakes
 * real people make — case, spaces, dashes, O for 0, I or L for 1 — and about two things an Arabic
 * reporter will hit: Arabic-Indic digits from an Arabic keyboard, and invisible bidi marks that come
 * along when text is copied out of right-to-left text.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 24; // 24 symbols x 5 bits = 120 bits
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{24}$/;

/** Returns the 24-symbol canonical code (no dashes). Show it to a person with {@link formatReportCode}. */
export function generateReportCode(): string {
  const bytes = randomBytes(15); // 120 bits
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** XXXX-XXXX-XXXX-XXXX-XXXX-XXXX: groups of four are easier to copy and to read out. */
export function formatReportCode(canonical: string): string {
  return canonical.match(/.{1,4}/g)?.join('-') ?? canonical;
}

const ARABIC_INDIC = /[٠-٩]/g;
const EXT_ARABIC_INDIC = /[۰-۹]/g;
// Bidi controls and no-break space: copy-paste out of Arabic text carries these invisibly.
const INVISIBLE = /[‎‏‪-‮⁦-⁩ ​﻿]/g;

/**
 * Turns whatever a person typed into the canonical code, or undefined if it cannot be one.
 * Never throws and never reveals why it failed: callers answer "not found" either way, so the
 * response does not tell a guesser whether they got the shape right.
 */
export function normaliseReportCode(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 128) return undefined;
  const s = input
    .replace(INVISIBLE, '')
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s\-_.]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE_SHAPE.test(s) ? s : undefined;
}

/** What is stored. Domain-separated, so this hash can never be confused with another SHA-256 in the system. */
export function hashReportCode(canonical: string): string {
  return createHash('sha256').update(`cms-report-code-v1:${canonical}`).digest('hex');
}
