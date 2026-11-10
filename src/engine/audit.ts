import { GENESIS_HASH, canonicalJson, sha256Hex } from './canonical';
import type { ActorKind } from './types';

export interface AuditEventInput {
  caseId: string;
  tenantId: string;
  type: string;
  actorId: string;
  actorKind: ActorKind;
  at: string;
  payload: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export function computeEventHash(e: Omit<AuditEvent, 'hash'>): string {
  return sha256Hex(
    canonicalJson({
      seq: e.seq,
      caseId: e.caseId,
      tenantId: e.tenantId,
      type: e.type,
      actorId: e.actorId,
      actorKind: e.actorKind,
      at: e.at,
      payload: e.payload,
      prevHash: e.prevHash,
    }),
  );
}

/** Append-only: returns a new log, never mutates. Each event commits to its predecessor. */
export function appendEvent(log: readonly AuditEvent[], input: AuditEventInput): AuditEvent[] {
  const prev = log[log.length - 1];
  if (prev && (prev.caseId !== input.caseId || prev.tenantId !== input.tenantId)) {
    throw new Error('AUDIT_LOG_SCOPE_MISMATCH: an audit chain belongs to exactly one case');
  }
  const partial = {
    ...input,
    seq: prev ? prev.seq + 1 : 1,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return [...log, { ...partial, hash: computeEventHash(partial) }];
}

export type ChainVerification = { valid: true } | { valid: false; brokenAt: number; reason: string };

export function verifyChain(log: readonly AuditEvent[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    if (e.seq !== i + 1) return { valid: false, brokenAt: i + 1, reason: 'SEQUENCE_GAP' };
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: e.seq, reason: 'PREV_HASH_MISMATCH' };
    const { hash, ...rest } = e;
    if (computeEventHash(rest) !== hash) return { valid: false, brokenAt: e.seq, reason: 'HASH_MISMATCH' };
    const first = log[0]!;
    if (e.caseId !== first.caseId || e.tenantId !== first.tenantId) {
      return { valid: false, brokenAt: e.seq, reason: 'SCOPE_MISMATCH' };
    }
    prevHash = e.hash;
  }
  return { valid: true };
}
