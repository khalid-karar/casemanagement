import type { Mutation } from './workflow';
import { AccessDeniedError } from './workflow';
import { canAccess } from './permissions';
import type { Actor, CaseState, CaseTypeDefinition } from './types';

/**
 * Legal hold: the moment a case is flagged likely-litigation its evidence is frozen.
 * Artifacts are already append-only; a hold additionally overrides retention (no purge) and
 * blocks archival where a case type's guards say so.
 */
export function placeLegalHold(c: CaseState, actor: Actor, reason: string, now: string): Mutation {
  const access = canAccess(actor, c, 'manage_hold');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  if (c.legalHold) throw new AccessDeniedError('LEGAL_HOLD_ALREADY_ACTIVE');
  return {
    case: { ...c, legalHold: { placedBy: actor.id, placedAt: now, reason } },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'legal_hold.placed',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { reason },
    },
  };
}

export function releaseLegalHold(c: CaseState, actor: Actor, reason: string, now: string): Mutation {
  const access = canAccess(actor, c, 'manage_hold');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  if (!c.legalHold) throw new AccessDeniedError('NO_LEGAL_HOLD');
  const { legalHold: _released, ...rest } = c;
  return {
    case: rest,
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'legal_hold.released',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { reason, placedAt: c.legalHold.placedAt },
    },
  };
}

export interface PurgeDecision {
  allowed: boolean;
  reason?: string;
}

/** Retention purge gate. A hold always wins; an unset retention period disables purge entirely. */
export function canPurge(def: CaseTypeDefinition, c: CaseState, nowIso: string): PurgeDecision {
  if (c.legalHold) return { allowed: false, reason: 'LEGAL_HOLD_ACTIVE' };
  if (def.retentionYears === null) return { allowed: false, reason: 'RETENTION_NOT_CONFIGURED' };
  if (!c.closedAt) return { allowed: false, reason: 'CASE_NOT_CLOSED' };
  const due = new Date(c.closedAt);
  due.setUTCFullYear(due.getUTCFullYear() + def.retentionYears);
  return Date.parse(nowIso) >= due.getTime() ? { allowed: true } : { allowed: false, reason: 'RETENTION_PERIOD_RUNNING' };
}
