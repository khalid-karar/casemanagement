import { appendEvent, verifyChain } from './audit';
import type { AuditEvent } from './audit';
import { sha256Hex } from './canonical';
import { FieldError } from './fields';
import { AccessDeniedError } from './workflow';
import type { Actor } from './types';

/**
 * Report & Track: an anonymous, two-way channel that sits BEFORE the case.
 *
 * A report is deliberately not a case. A case has a number, an SLA clock, statutory clocks and a
 * department wall; a raw report from someone who may be mistaken, angry, or filing a duplicate has none
 * of those yet, and giving it one would pollute breach statistics and Labour Law clocks with noise. A
 * report is triaged by an ethics officer, and only then converted into a case (or dismissed).
 *
 * Anonymity is a property of what is NOT stored: no name, no address, no user agent, no session. The
 * reporter's only credential is a reference code (see security/reportcode.ts); the report keeps its hash.
 *
 * History is a hash chain (the same one the case audit log uses). Each event commits to the SHA-256 of a
 * message's text rather than to the text, so the chain proves "this message existed at this time, unaltered"
 * without becoming a second plaintext copy — the text itself is encrypted at rest like any sensitive field.
 */
export const REPORT_CATEGORIES = ['HR', 'SECURITY', 'AUDIT', 'LEGAL', 'UNSURE'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_LANGUAGES = ['ar', 'en', 'other'] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];
export type ReportStatus = 'UNTRIAGED' | 'CONVERTED' | 'DISMISSED';

export const MAX_REPORT_TEXT = 20_000;
export const MIN_REPORT_TEXT = 10;
export const MAX_REPLY_TEXT = 5_000;
/** A thread is a conversation, not a file drop: past this, staff must convert or dismiss. */
export const MAX_THREAD_MESSAGES = 100;
const MIN_NOTE = 10;
const MAX_NOTE = 2_000;

export interface ReportMessage {
  /** 1-based position in the thread. */
  n: number;
  /** The history event that recorded this message. */
  eventSeq: number;
  at: string;
  author: 'REPORTER' | 'STAFF';
  /** Staff only. NEVER reaches the reporter. */
  authorId?: string;
  /** Encrypted at rest. */
  text: string;
  sha256: string;
}

export interface Report {
  id: string;
  tenantId: string;
  channelId: string;
  /** Hash of the reference code. The code itself is never stored. */
  codeHash: string;
  status: ReportStatus;
  /** The reporter's own suggestion. Triage decides; this never routes anything. */
  category: ReportCategory;
  language: ReportLanguage;
  createdAt: string;
  updatedAt: string;
  messages: ReportMessage[];
  events: AuditEvent[];
  /** Set on conversion. Staff only: the reporter is never told which case, department or person took it up. */
  caseId?: string;
  /** Why it was dismissed. Staff only; encrypted at rest. */
  closingNote?: string;
  /**
   * Storage detail, set and cleared by the encrypting repository and never by engine code: true means every message
   * text and the closing note are ciphertext. It is an explicit marker rather than a sniff of the text, because the
   * text comes from an anonymous stranger and could simply begin with the ciphertext prefix.
   */
  sealed?: true;
}

const bad = (field: string, code: string) => new FieldError('VALIDATION', [{ field, code }]);

/** Normalises and bounds free text from either side. Control characters other than newline and tab are dropped. */
function cleanText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== 'string') throw bad(field, 'EXPECTED_TEXT');
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (t.length < min) throw bad(field, 'TEXT_TOO_SHORT');
  if (t.length > max) throw bad(field, 'TEXT_TOO_LONG');
  return t;
}

/** Only an ethics officer triages reports. Not a role a department head can acquire by holding another one. */
export function canTriageReports(actor: Pick<Actor, 'kind' | 'roles'>): boolean {
  return actor.kind === 'human' && actor.roles.includes('ethics_officer');
}
function requireTriager(actor: Actor, tenantId: string) {
  if (actor.tenantId !== tenantId) throw new AccessDeniedError('TENANT_MISMATCH');
  if (!canTriageReports(actor)) throw new AccessDeniedError('ROLE_REQUIRED:ethics_officer');
}

function record(
  r: Report, type: string, actor: { id: string; kind: 'reporter' | 'human' }, now: string, payload: Record<string, unknown>,
): AuditEvent[] {
  return appendEvent(r.events, { caseId: r.id, tenantId: r.tenantId, type, actorId: actor.id, actorKind: actor.kind, at: now, payload });
}

const REPORTER = { id: 'reporter', kind: 'reporter' } as const;

export function createReport(
  input: { id: string; tenantId: string; channelId: string; category: unknown; language: unknown; text: unknown; codeHash: string },
  now: string,
): Report {
  const text = cleanText(input.text, 'text', MIN_REPORT_TEXT, MAX_REPORT_TEXT);
  if (!REPORT_CATEGORIES.includes(input.category as ReportCategory)) throw bad('category', 'NOT_AN_ALLOWED_OPTION');
  if (!REPORT_LANGUAGES.includes(input.language as ReportLanguage)) throw bad('language', 'NOT_AN_ALLOWED_OPTION');
  const sha256 = sha256Hex(text);
  const base: Report = {
    id: input.id, tenantId: input.tenantId, channelId: input.channelId, codeHash: input.codeHash, status: 'UNTRIAGED',
    category: input.category as ReportCategory, language: input.language as ReportLanguage, createdAt: now, updatedAt: now, messages: [], events: [],
  };
  const events = record(base, 'report.received', REPORTER, now, {
    channelId: input.channelId, category: input.category, language: input.language, messageN: 1, textSha256: sha256, length: text.length,
  });
  return { ...base, events, messages: [{ n: 1, eventSeq: 1, at: now, author: 'REPORTER', text, sha256 }] };
}

function addMessage(r: Report, author: 'REPORTER' | 'STAFF', authorId: string | undefined, text: string, now: string, type: string, extra: Record<string, unknown> = {}): Report {
  if (r.messages.length >= MAX_THREAD_MESSAGES) throw new AccessDeniedError('REPORT_THREAD_FULL');
  const n = r.messages.length + 1;
  const sha256 = sha256Hex(text);
  const actor = author === 'REPORTER' ? REPORTER : { id: authorId!, kind: 'human' as const };
  const events = record(r, type, actor, now, { messageN: n, textSha256: sha256, length: text.length, ...extra });
  const m: ReportMessage = { n, eventSeq: events.length, at: now, author, ...(authorId ? { authorId } : {}), text, sha256 };
  return { ...r, events, messages: [...r.messages, m], updatedAt: now };
}

/**
 * A reporter writes back. On a dismissed report this reopens it: someone who says "you missed the second
 * half" deserves a second look, and the thread cap bounds how far that can be abused.
 */
export function reporterReply(r: Report, text: unknown, now: string): Report {
  const t = cleanText(text, 'text', 1, MAX_REPLY_TEXT);
  let next = addMessage(r, 'REPORTER', undefined, t, now, 'report.reporter_message');
  if (r.status === 'DISMISSED') {
    next = { ...next, status: 'UNTRIAGED', events: record(next, 'report.reopened', REPORTER, now, { from: 'DISMISSED' }) };
  }
  return next;
}

export function staffReply(r: Report, text: unknown, actor: Actor, now: string): Report {
  requireTriager(actor, r.tenantId);
  return addMessage(r, 'STAFF', actor.id, cleanText(text, 'text', 1, MAX_REPLY_TEXT), now, 'report.staff_message');
}

export function convertReport(r: Report, caseId: string, actor: Actor, now: string): Report {
  requireTriager(actor, r.tenantId);
  if (r.status === 'CONVERTED') throw new AccessDeniedError('REPORT_ALREADY_CONVERTED');
  const events = record(r, 'report.converted', { id: actor.id, kind: 'human' }, now, { caseId });
  return { ...r, status: 'CONVERTED', caseId, events, updatedAt: now };
}

export function dismissReport(r: Report, note: unknown, actor: Actor, now: string): Report {
  requireTriager(actor, r.tenantId);
  if (r.status === 'CONVERTED') throw new AccessDeniedError('REPORT_ALREADY_CONVERTED');
  const closingNote = cleanText(note, 'note', MIN_NOTE, MAX_NOTE);
  // The note is staff-only free text, so the history holds its digest rather than a copy of it.
  const events = record(r, 'report.dismissed', { id: actor.id, kind: 'human' }, now, { noteSha256: sha256Hex(closingNote) });
  return { ...r, status: 'DISMISSED', closingNote, events, updatedAt: now };
}

/** Whether the last word is the reporter's: the thing a triager sorts by. */
export const awaitingStaff = (r: Report): boolean => r.messages[r.messages.length - 1]?.author === 'REPORTER' && r.status !== 'DISMISSED';

// ---------------------------------------------------------------------------
// Views. Two on purpose: what the reporter may see, and what staff may.
// ---------------------------------------------------------------------------

export type ReporterStatus = 'RECEIVED' | 'ACCEPTED' | 'CLOSED';
export interface ReporterView {
  status: ReporterStatus;
  createdAt: string;
  messages: { n: number; at: string; from: 'YOU' | 'TEAM'; text: string }[];
  canReply: boolean;
}

/**
 * Built field by field, never by spreading the report, so a field added to Report later is invisible to the
 * reporter until someone decides it should not be. Notably absent: staff ids, the case id, the category the
 * triager chose, the closing note, and every hash. "Accepted" says the report was taken up — not by whom or where.
 */
export function reporterView(r: Report): ReporterView {
  return {
    status: r.status === 'UNTRIAGED' ? 'RECEIVED' : r.status === 'CONVERTED' ? 'ACCEPTED' : 'CLOSED',
    createdAt: r.createdAt,
    messages: r.messages.map((m) => ({ n: m.n, at: m.at, from: m.author === 'REPORTER' ? 'YOU' : 'TEAM', text: m.text })),
    canReply: r.messages.length < MAX_THREAD_MESSAGES,
  };
}

export interface StaffReportSummary {
  id: string; status: ReportStatus; category: ReportCategory; language: ReportLanguage; channelId: string;
  createdAt: string; updatedAt: string; messageCount: number; awaitingStaff: boolean; caseId?: string;
}
export const staffSummary = (r: Report): StaffReportSummary => ({
  id: r.id, status: r.status, category: r.category, language: r.language, channelId: r.channelId, createdAt: r.createdAt, updatedAt: r.updatedAt,
  messageCount: r.messages.length, awaitingStaff: awaitingStaff(r), ...(r.caseId ? { caseId: r.caseId } : {}),
});

/** Staff see the thread and the outcome, but never the code hash or the chain internals. */
export const staffView = (r: Report) => ({
  ...staffSummary(r),
  messages: r.messages.map((m) => ({ n: m.n, at: m.at, author: m.author, ...(m.authorId ? { authorId: m.authorId } : {}), text: m.text })),
  ...(r.closingNote ? { closingNote: r.closingNote } : {}),
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export type ReportIntegrity = { valid: true } | { valid: false; reason: string };

/**
 * The chain must verify AND every message must still match the digest the chain committed to. Run after
 * decryption, so a wrong key or a swapped ciphertext fails here rather than showing altered text.
 */
export function verifyReport(r: Report): ReportIntegrity {
  const chain = verifyChain(r.events);
  if (!chain.valid) return { valid: false, reason: `CHAIN_${chain.reason}` };
  if (r.events.some((e) => e.caseId !== r.id || e.tenantId !== r.tenantId)) return { valid: false, reason: 'SCOPE_MISMATCH' };
  // Completeness, not just correctness of what is present: the chain recorded one event per message, so a
  // message that has been deleted — above all the reporter's original words — must fail here, and the
  // numbering must run 1..k with no gap or reorder.
  const recorded = r.events.filter((e) => e.payload.messageN !== undefined).length;
  if (r.messages.length !== recorded) return { valid: false, reason: 'MESSAGE_MISSING' };
  if (r.messages.some((m, i) => m.n !== i + 1)) return { valid: false, reason: 'MESSAGE_ORDER' };
  let last = 0;
  for (const m of r.messages) {
    const e = r.events[m.eventSeq - 1];
    if (!e || m.eventSeq <= last) return { valid: false, reason: `MESSAGE_${m.n}_EVENT_MISSING` };
    if (e.payload.messageN !== m.n || e.payload.textSha256 !== m.sha256) return { valid: false, reason: `MESSAGE_${m.n}_NOT_IN_CHAIN` };
    if (sha256Hex(m.text) !== m.sha256) return { valid: false, reason: `MESSAGE_${m.n}_ALTERED` };
    last = m.eventSeq;
  }
  return { valid: true };
}
