import { createHash } from 'node:crypto';
import { AccessDeniedError, addArtifact, evaluateTransition } from '../engine';
import type { Actor, CaseState, CaseTypeDefinition, Mutation } from '../engine';
import { NajizError } from './types';
import type { FilingAttachment, FilingPacket, FilingParty, Forum, NajizStatus, UpdatesResult } from './types';

/**
 * How a legal matter talks to Najiz. Pure rules, no I/O; the routes in app.ts do the calling.
 *
 * Principles (a filing in court is not undoable):
 *  1. What leaves is built from an allowlist: the title, forum, claim value, the opposing party, the claimant, and
 *     documents of type `filing` / `exhibit` only. Never the whole case, never other artifacts, never fields not listed.
 *  2. Dual control: counsel submits, a DIFFERENT general counsel must have approved after the filing documents were
 *     last changed and after the previous attempt, so an approval covers exactly one attempt of one version.
 *  3. Record before sending, record after: a `najiz_filing_pending` artifact is committed before the call. If we crash,
 *     or Najiz does not answer, the attempt stays unresolved and blocks another one until a person reconciles.
 *  4. Nothing happens automatically: Najiz events become artifacts (hearing_record, judgment …); counsel still performs
 *     the case transitions, so the platform's guards and audit stay in charge.
 */
export class NajizRuleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'NajizRuleError'; }
}

export const NAJIZ_ARTIFACT = {
  pending: 'najiz_filing_pending',
  result: 'najiz_filing_result',
  rejected: 'najiz_filing_rejected',
  notSent: 'najiz_filing_not_sent',
  unconfirmed: 'najiz_filing_unconfirmed',
  reconciliation: 'najiz_reconciliation',
  status: 'najiz_status',
} as const;
const ATTACHABLE = ['filing', 'exhibit'];
const h = (s: string) => createHash('sha256').update(s).digest('hex');

export type NajizCaseState =
  | { state: 'NOT_SUBMITTED'; attempts: number }
  | { state: 'IN_PROGRESS' | 'UNCONFIRMED'; key: string; attempts: number }
  | { state: 'SUBMITTED'; key: string; najizRef: string; attempts: number };

/** Where this matter stands with Najiz, derived only from its artifacts (so it is audited and cannot drift). */
export function najizState(cs: CaseState): NajizCaseState {
  const pendings = cs.artifacts.filter((a) => a.type === NAJIZ_ARTIFACT.pending);
  const last = pendings[pendings.length - 1];
  if (!last) return { state: 'NOT_SUBMITTED', attempts: 0 };
  const key = String(last.payload?.idempotencyKey);
  const mine = (type: string) => cs.artifacts.filter((a) => a.type === type && a.payload?.key === key);
  const attempts = pendings.length;
  const rec = mine(NAJIZ_ARTIFACT.reconciliation).pop();
  if (rec) return rec.payload?.outcome === 'filed' ? { state: 'SUBMITTED', key, najizRef: String(rec.payload.najizRef), attempts } : { state: 'NOT_SUBMITTED', attempts };
  const res = mine(NAJIZ_ARTIFACT.result).pop();
  if (res) return { state: 'SUBMITTED', key, najizRef: String(res.payload?.najizRef), attempts };
  if (mine(NAJIZ_ARTIFACT.rejected).length || mine(NAJIZ_ARTIFACT.notSent).length) return { state: 'NOT_SUBMITTED', attempts };
  if (mine(NAJIZ_ARTIFACT.unconfirmed).length) return { state: 'UNCONFIRMED', key, attempts };
  return { state: 'IN_PROGRESS', key, attempts };
}

const FORUMS: Forum[] = ['LABOUR_COURT', 'CRIMINAL_COURT', 'COMMERCIAL_COURT', 'BOARD_OF_GRIEVANCES', 'OTHER'];

export interface PacketPlan { packet: Omit<FilingPacket, 'attachments'> & { attachments: Omit<FilingAttachment, 'bytes'>[] }; load: string[] }

/** The summary an approver sees: exactly what would be sent, with hashes, without the bytes. */
export function planPacket(cs: CaseState, claimant: FilingParty, attempts: number): PacketPlan {
  const forum = cs.fields['forum'];
  if (typeof forum !== 'string' || !FORUMS.includes(forum as Forum)) throw new NajizRuleError('FORUM_REQUIRED');
  const title = typeof cs.fields['title'] === 'string' ? (cs.fields['title'] as string) : '';
  if (!title) throw new NajizRuleError('TITLE_REQUIRED');
  const docs = cs.artifacts.filter((a) => ATTACHABLE.includes(a.type) && a.hash);
  const filings = docs.filter((a) => a.type === 'filing');
  if (!filings.length) throw new NajizRuleError('FILING_DOCUMENT_REQUIRED');
  const main = filings[filings.length - 1]!; // the latest version of the filing
  const exhibits = docs.filter((a) => a.type === 'exhibit');
  const ordered = [main, ...exhibits];
  const opposing = cs.fields['opposingParty'];
  const parties: FilingParty[] = [claimant];
  if (typeof opposing === 'string' && opposing) parties.push({ role: 'DEFENDANT', kind: 'PERSON', identifierType: 'OTHER', identifier: opposing, name: opposing });
  const claim = cs.fields['claimValueSar'];
  const idempotencyKey = h(`${cs.tenantId}|${cs.id}|${ordered.map((a) => a.hash).join(',')}|${attempts + 1}`);
  return {
    load: ordered.map((a) => a.hash!),
    packet: {
      idempotencyKey, matterId: cs.id, forum: forum as Forum, title, claimSubject: title,
      ...(typeof claim === 'number' ? { claimValueSar: claim } : {}),
      parties,
      attachments: ordered.map((a) => ({ name: String(a.payload?.name ?? a.id), mime: String(a.payload?.mime ?? 'application/octet-stream'), sha256: a.hash!, size: Number(a.payload?.size ?? 0) })),
    },
  };
}

/** Approvals that currently count for the next attempt: general counsel, recorded after the last filing document or attempt. */
export function currentApprovals(cs: CaseState): string[] {
  const since = cs.artifacts.filter((a) => ATTACHABLE.includes(a.type) || a.type === NAJIZ_ARTIFACT.pending).reduce((m, a) => (a.createdAt > m ? a.createdAt : m), '');
  return [...new Set(cs.approvals.filter((a) => a.role === 'general_counsel' && a.at > since).map((a) => a.approverId))];
}

/** Whether `actor` may send now. Throws NajizRuleError / AccessDeniedError / TransitionBlockedError (via evaluateTransition). */
export function assertMaySubmit(def: CaseTypeDefinition, cs: CaseState, actor: Actor): NajizCaseState {
  if (cs.caseTypeKey !== 'legal.matter') throw new NajizRuleError('NOT_A_LEGAL_MATTER');
  if (actor.kind !== 'human' || !actor.roles.includes('legal_counsel')) throw new AccessDeniedError('ROLE_REQUIRED:legal_counsel');
  if (cs.state !== 'PRE_ACTION') throw new NajizRuleError('MATTER_NOT_IN_PRE_ACTION');
  // Everything the 'file' step demands (forum, filing attached, labour settlement attempt) must already hold.
  const ev = evaluateTransition(def, cs, 'file', actor);
  const hard = ev.blockers.filter((b) => !(b.code.startsWith('APPROVAL')));
  if (hard.length) throw new NajizRuleError('FILE_PREREQUISITES:' + hard.map((b) => b.code).join(','));
  const st = najizState(cs);
  if (st.state === 'IN_PROGRESS') throw new NajizRuleError('ATTEMPT_IN_PROGRESS');
  if (st.state === 'UNCONFIRMED') throw new NajizRuleError('ATTEMPT_UNCONFIRMED_RECONCILE_FIRST');
  if (st.state === 'SUBMITTED') throw new NajizRuleError('ALREADY_SUBMITTED');
  // Dual control, bound to this version and this attempt.
  const attachable = cs.artifacts.filter((a) => ATTACHABLE.includes(a.type) || a.type === NAJIZ_ARTIFACT.pending);
  const since = attachable.reduce((m, a) => (a.createdAt > m ? a.createdAt : m), '');
  const ok = cs.approvals.some((a) => a.role === 'general_counsel' && a.approverId !== actor.id && a.at > since);
  if (!ok) throw new NajizRuleError('APPROVAL_REQUIRED');
  return st;
}

export function pendingArtifact(plan: PacketPlan, actor: Actor, now: string, approvedBy: string, sim: boolean) {
  const key = plan.packet.idempotencyKey;
  return { id: `najiz-pending-${key.slice(0, 16)}`, type: NAJIZ_ARTIFACT.pending, payload: { idempotencyKey: key, submittedBy: actor.id, approvedBy, at: now, simulated: sim, attachments: plan.packet.attachments.map((a) => a.sha256) } };
}

export function approverOf(cs: CaseState, actor: Actor): string {
  return [...cs.approvals].reverse().find((a) => a.role === 'general_counsel' && a.approverId !== actor.id)?.approverId ?? '';
}

/** The artifact that resolves an attempt, from what Najiz (or the network) told us. */
export function resolution(key: string, outcome: { ok: { najizRef: string; status: NajizStatus; courtCaseNumber?: string; acceptedAt: string } } | { err: NajizError }, sim: boolean) {
  const k = key.slice(0, 16);
  if ('ok' in outcome) return { id: `najiz-result-${k}`, type: NAJIZ_ARTIFACT.result, payload: { key, najizRef: outcome.ok.najizRef, status: outcome.ok.status, acceptedAt: outcome.ok.acceptedAt, simulated: sim, ...(outcome.ok.courtCaseNumber ? { courtCaseNumber: outcome.ok.courtCaseNumber } : {}) } };
  const e = outcome.err;
  const type = e.code === 'REJECTED' ? NAJIZ_ARTIFACT.rejected : e.code === 'AMBIGUOUS' ? NAJIZ_ARTIFACT.unconfirmed : NAJIZ_ARTIFACT.notSent;
  const id = type === NAJIZ_ARTIFACT.rejected ? 'najiz-rejected-' : type === NAJIZ_ARTIFACT.unconfirmed ? 'najiz-unconfirmed-' : 'najiz-notsent-';
  return { id: id + k, type, payload: { key, code: e.code, ...(e.code === 'REJECTED' && e.detail ? { reason: e.detail.slice(0, 500) } : {}), simulated: sim } };
}

export function reconcile(cs: CaseState, actor: Actor, body: { outcome: 'filed' | 'not_filed'; najizRef?: string; note?: string }, now: string): Mutation {
  if (actor.kind !== 'human' || !actor.roles.includes('general_counsel')) throw new AccessDeniedError('ROLE_REQUIRED:general_counsel');
  const st = najizState(cs);
  if (st.state !== 'UNCONFIRMED' && st.state !== 'IN_PROGRESS') throw new NajizRuleError('NOTHING_TO_RECONCILE');
  if (body.outcome === 'filed' && !(typeof body.najizRef === 'string' && /^[A-Za-z0-9._:/-]{3,100}$/.test(body.najizRef))) throw new NajizRuleError('NAJIZ_REFERENCE_REQUIRED');
  if (body.outcome !== 'filed' && body.outcome !== 'not_filed') throw new NajizRuleError('OUTCOME_REQUIRED');
  return addArtifact(cs, {
    id: `najiz-reconciled-${st.key.slice(0, 16)}`, type: NAJIZ_ARTIFACT.reconciliation,
    payload: { key: st.key, outcome: body.outcome, ...(body.najizRef ? { najizRef: body.najizRef } : {}), note: String(body.note ?? '').slice(0, 1000), reconciledBy: actor.id, at: now },
  }, actor, now);
}

/** Artifacts to add after reading Najiz's updates. Idempotent: ids derive from Najiz's own event ids and statuses. */
export function importUpdates(cs: CaseState, u: UpdatesResult, sim: boolean): { artifacts: { id: string; type: string; payload: Record<string, unknown>; hash?: string }[]; documents: { sha256: string; name: string; mime: string; bytes: Uint8Array }[]; courtCaseNumber?: string } {
  const have = new Set(cs.artifacts.map((a) => a.id));
  const artifacts: { id: string; type: string; payload: Record<string, unknown>; hash?: string }[] = [];
  const documents: { sha256: string; name: string; mime: string; bytes: Uint8Array }[] = [];
  const statusId = `najiz-status-${u.status.toLowerCase()}`;
  if (!have.has(statusId)) artifacts.push({ id: statusId, type: NAJIZ_ARTIFACT.status, payload: { status: u.status, simulated: sim } });
  for (const ev of u.events) {
    const id = `najiz-evt-${h(ev.eventId).slice(0, 16)}`;
    if (have.has(id)) continue;
    const type = ev.kind === 'HEARING' ? 'hearing_record' : ev.kind === 'JUDGMENT' ? 'judgment' : 'najiz_notice';
    const payload: Record<string, unknown> = { source: sim ? 'SIMULATED-NAJIZ' : 'NAJIZ', eventId: ev.eventId, at: ev.at, summary: ev.summary.slice(0, 1000), simulated: sim, ...(ev.hearingAt ? { hearingAt: ev.hearingAt } : {}) };
    let hash: string | undefined;
    if (ev.document) {
      hash = createHash('sha256').update(ev.document.bytes).digest('hex');
      documents.push({ sha256: hash, name: ev.document.name.replace(/[^\w.\- ؀-ۿ]/g, '_').slice(0, 120), mime: ev.document.mime, bytes: ev.document.bytes });
      payload['name'] = ev.document.name; payload['mime'] = ev.document.mime; payload['size'] = ev.document.bytes.byteLength;
    }
    artifacts.push({ id, type, payload, ...(hash ? { hash } : {}) });
  }
  return { artifacts, documents, ...(u.courtCaseNumber ? { courtCaseNumber: u.courtCaseNumber } : {}) };
}

