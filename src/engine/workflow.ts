import type { AuditEventInput } from './audit';
import { canAccess } from './permissions';
import { assertValidId, planFieldEdit, validateFields } from './fields';
import type {
  Actor,
  Artifact,
  Assignee,
  Blocker,
  CaseState,
  CaseTypeDefinition,
  Evaluation,
  Guard,
  Party,
} from './types';

export class TransitionBlockedError extends Error {
  constructor(public readonly blockers: Blocker[]) {
    super(`Transition blocked: ${blockers.map((b) => b.code).join(', ')}`);
    this.name = 'TransitionBlockedError';
  }
}

export class AccessDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`Access denied: ${reason}`);
    this.name = 'AccessDeniedError';
  }
}

export class ConflictOfInterestError extends Error {
  constructor(public readonly codes: string[]) {
    super(`Conflict of interest: ${codes.join(', ')}`);
    this.name = 'ConflictOfInterestError';
  }
}

/** A state change plus the audit event describing it. The caller appends the event to the case's chain. */
export interface Mutation {
  case: CaseState;
  event: AuditEventInput;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

// ---------------------------------------------------------------------------
// Conflict of interest (ISO 37002 impartiality, made cheap to enforce)
// ---------------------------------------------------------------------------

export function findConflicts(assignee: Assignee, parties: Party[]): string[] {
  const codes: string[] = [];
  for (const p of parties) {
    if (p.personId === assignee.id) codes.push(`ASSIGNEE_IS_${p.role}`);
    if (p.role === 'SUBJECT' && p.reportsTo.includes(assignee.id)) codes.push('ASSIGNEE_MANAGES_SUBJECT');
    if (p.role === 'SUBJECT' && assignee.reportsTo.includes(p.personId)) codes.push('SUBJECT_MANAGES_ASSIGNEE');
  }
  return [...new Set(codes)];
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function sequenceSatisfied(artifacts: Artifact[], types: string[]): boolean {
  let floor = Number.NEGATIVE_INFINITY;
  for (const type of types) {
    const earliest = artifacts
      .filter((a) => a.type === type)
      .map((a) => Date.parse(a.createdAt))
      .filter((t) => t >= floor)
      .sort((a, b) => a - b)[0];
    if (earliest === undefined) return false;
    floor = earliest;
  }
  return true;
}

function evalGuard(g: Guard, c: CaseState, actor: Actor): Blocker | null {
  if (g.when) {
    const v = c.fields[g.when.field];
    if (typeof v !== 'string' || !g.when.in.includes(v)) return null;
  }
  switch (g.kind) {
    case 'role':
      return actor.roles.some((r) => g.anyOf.includes(r))
        ? null
        : { code: 'ROLE_REQUIRED', message: `Requires one of: ${g.anyOf.join(', ')}`, messageAr: `يتطلب أحد الأدوار: ${g.anyOf.join('، ')}` };
    case 'artifact_present':
      return c.artifacts.some((a) => a.type === g.artifactType)
        ? null
        : { code: `MISSING_ARTIFACT:${g.artifactType}`, message: g.message.en, messageAr: g.message.ar };
    case 'artifact_sequence':
      return sequenceSatisfied(c.artifacts, g.types)
        ? null
        : { code: 'ARTIFACT_SEQUENCE', message: g.message.en, messageAr: g.message.ar };
    case 'artifact_attr': {
      const ok = c.artifacts.some((a) => {
        if (a.type !== g.artifactType) return false;
        const v = a.payload?.[g.attr];
        const s = typeof v === 'string' ? v : undefined;
        if (g.in && (s === undefined || !g.in.includes(s))) return false;
        if (g.notIn && s !== undefined && g.notIn.includes(s)) return false;
        return true;
      });
      return ok ? null : { code: `ARTIFACT_ATTR:${g.artifactType}.${g.attr}`, message: g.message.en, messageAr: g.message.ar };
    }
    case 'field_present':
      return present(c.fields[g.field])
        ? null
        : { code: `MISSING_FIELD:${g.field}`, message: g.message.en, messageAr: g.message.ar };
    case 'field_in': {
      const v = c.fields[g.field];
      return typeof v === 'string' && g.values.includes(v)
        ? null
        : { code: `FIELD_VALUE:${g.field}`, message: g.message.en, messageAr: g.message.ar };
    }
    case 'approval':
      return c.approvals.some((a) => a.role === g.approverRole && a.approverId !== actor.id)
        ? null
        : { code: `APPROVAL_REQUIRED:${g.approverRole}`, message: `Needs approval from ${g.approverRole} (someone other than the person acting)`, messageAr: `يتطلب موافقة ${g.approverRole} من شخص غير المنفّذ` };
    case 'assignee_set':
      return c.assignee ? null : { code: 'ASSIGNEE_REQUIRED', message: 'An assignee must be set first', messageAr: 'يجب تحديد المسؤول أولاً' };
    case 'no_conflict_of_interest': {
      if (!c.assignee) return null;
      const codes = findConflicts(c.assignee, c.parties);
      return codes.length ? { code: 'CONFLICT_OF_INTEREST', message: codes.join(', ') } : null;
    }
    case 'actions_planned': {
      const bad = c.actions.filter((a) => a.status === 'OPEN' && (!a.ownerId || !a.dueDate));
      return bad.length
        ? { code: 'ACTIONS_UNPLANNED', message: `Open actions need an owner and due date: ${bad.map((a) => a.id).join(', ')}`, messageAr: `الإجراءات المفتوحة تحتاج مسؤولاً وتاريخ استحقاق: ${bad.map((a) => a.id).join('، ')}` }
        : null;
    }
    case 'evidence_integrity': {
      const bad = c.artifacts.filter((a) => a.type === 'evidence' && !(a.hash && SHA256_HEX.test(a.hash)));
      return bad.length
        ? { code: 'EVIDENCE_UNHASHED', message: `Evidence without a sha256 hash: ${bad.map((a) => a.id).join(', ')}`, messageAr: `أدلة بدون بصمة sha256: ${bad.map((a) => a.id).join('، ')}` }
        : null;
    }
    case 'legal_hold_active':
      return c.legalHold ? null : { code: 'LEGAL_HOLD_REQUIRED', message: 'A legal hold must be in place first', messageAr: 'يجب تفعيل التجميد القانوني أولاً' };
    case 'not_on_legal_hold':
      return c.legalHold ? { code: 'LEGAL_HOLD_ACTIVE', message: 'Blocked while a legal hold is in place', messageAr: 'محظور أثناء سريان التجميد القانوني' } : null;
  }
}

// ---------------------------------------------------------------------------
// Evaluate / apply
// ---------------------------------------------------------------------------

/**
 * Why a transition is or isn't allowed. Always returns every blocker so the UI can show them all.
 * Three invariants are enforced here regardless of what a case type's guards say:
 * an AI actor can never transition a case, nothing crosses tenants, and the actor must have access.
 */
export function evaluateTransition(
  def: CaseTypeDefinition,
  c: CaseState,
  action: string,
  actor: Actor,
): Evaluation {
  const t = def.transitions.find((x) => x.action === action);
  if (!t) return { allowed: false, blockers: [{ code: 'UNKNOWN_ACTION', message: `Unknown action "${action}"`, messageAr: 'إجراء غير معروف' }] };

  const blockers: Blocker[] = [];
  if (def.key !== c.caseTypeKey) blockers.push({ code: 'DEFINITION_MISMATCH', message: 'Case does not belong to this case type', messageAr: 'القضية لا تنتمي إلى هذا النوع' });
  if (actor.kind === 'ai') blockers.push({ code: 'AI_CANNOT_TRANSITION', message: 'AI output is a draft; a human must act', messageAr: 'مخرجات الذكاء الاصطناعي مسودة؛ يجب أن يتصرف إنسان' });

  const access = canAccess(actor, c, 'transition');
  if (!access.allowed) blockers.push({ code: access.reason ?? 'NO_ACCESS', message: 'Actor has no access to this case', messageAr: 'لا تملك صلاحية الوصول إلى هذه القضية' });

  if (!t.from.includes(c.state)) {
    blockers.push({ code: 'INVALID_STATE', message: `"${action}" is not allowed from state ${c.state}`, messageAr: `الإجراء غير مسموح من الحالة ${c.state}` });
  }
  for (const g of t.guards) {
    const b = evalGuard(g, c, actor);
    if (b) blockers.push(b);
  }
  return { allowed: blockers.length === 0, blockers, transition: t };
}

export function applyTransition(
  def: CaseTypeDefinition,
  c: CaseState,
  action: string,
  actor: Actor,
  now: string,
): Mutation {
  const ev = evaluateTransition(def, c, action, actor);
  if (!ev.allowed || !ev.transition) throw new TransitionBlockedError(ev.blockers);

  const to = ev.transition.to;
  const toKind = def.states.find((s) => s.key === to)?.kind;
  const next: CaseState = { ...c, state: to, stateEnteredAt: now };
  if ((toKind === 'CLOSED' || toKind === 'ARCHIVED') && !next.closedAt) next.closedAt = now;

  return {
    case: next,
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'case.transition',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { action, from: c.state, to },
    },
  };
}

// ---------------------------------------------------------------------------
// Case lifecycle helpers
// ---------------------------------------------------------------------------

export function createCase(
  def: CaseTypeDefinition,
  input: { id: string; fields?: Record<string, unknown>; parties?: Party[] },
  actor: Actor,
  now: string,
): Mutation {
  if (actor.kind === 'ai') throw new AccessDeniedError('AI_CANNOT_CREATE_CASE');
  assertValidId(input.id, 'id');
  validateFields(def, input.fields ?? {});
  const draft: CaseState = {
    id: input.id,
    tenantId: actor.tenantId,
    caseTypeKey: def.key,
    caseTypeVersion: def.version,
    department: def.domain,
    state: def.initialState,
    stateEnteredAt: now,
    confidentiality: def.defaultConfidentiality,
    fields: Object.fromEntries(Object.entries(input.fields ?? {}).filter(([, v]) => v !== null)),
    parties: input.parties ?? [],
    artifacts: [],
    approvals: [],
    actions: [],
    ...(def.domain === 'LEGAL' ? { matterId: input.id } : {}),
    createdBy: actor.id,
    createdAt: now,
  };
  const access = canAccess(actor, draft, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  return {
    case: draft,
    event: {
      caseId: draft.id,
      tenantId: draft.tenantId,
      type: 'case.created',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { caseType: def.key, version: def.version },
    },
  };
}

export function setFields(c: CaseState, patch: Record<string, unknown>, actor: Actor, now: string, def: CaseTypeDefinition): Mutation {
  const access = canAccess(actor, c, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  const { next, changes, deniedSealed } = planFieldEdit(def, c, patch, actor);
  if (deniedSealed.length) throw new AccessDeniedError(`SEALED_FIELD_WRITE:${deniedSealed.join(',')}`);
  return {
    case: { ...c, fields: next },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'case.fields_updated',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      // Old and new value for ordinary fields; SHA-256 only for personal and sealed ones.
      payload: { changes },
    },
  };
}

/** Artifacts are append-only and timestamped by the engine, so they can't be backdated or removed. */
export function addArtifact(
  c: CaseState,
  input: { id: string; type: string; hash?: string; payload?: Record<string, unknown> },
  actor: Actor,
  now: string,
): Mutation {
  const access = canAccess(actor, c, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  assertValidId(input.id, 'artifact.id');
  if (c.artifacts.some((a) => a.id === input.id)) throw new AccessDeniedError('ARTIFACT_ID_EXISTS');
  const artifact: Artifact = {
    id: input.id,
    type: input.type,
    createdAt: now,
    createdBy: actor.id,
    ...(input.hash ? { hash: input.hash } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };
  return {
    case: { ...c, artifacts: [...c.artifacts, artifact] },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'artifact.added',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { artifactId: input.id, artifactType: input.type, hash: input.hash ?? null },
    },
  };
}

export function recordApproval(c: CaseState, role: string, actor: Actor, now: string): Mutation {
  if (actor.kind !== 'human') throw new AccessDeniedError('APPROVAL_REQUIRES_HUMAN');
  if (!actor.roles.includes(role)) throw new AccessDeniedError(`ROLE_REQUIRED:${role}`);
  const access = canAccess(actor, c, 'transition');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  return {
    case: { ...c, approvals: [...c.approvals, { role, approverId: actor.id, at: now }] },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'approval.recorded',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { role },
    },
  };
}

/** Assignment is where impartiality is enforced: a conflicted assignee is rejected outright. */
export function assignCase(c: CaseState, assignee: Assignee, actor: Actor, now: string): Mutation {
  const access = canAccess(actor, c, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  const conflicts = findConflicts(assignee, c.parties);
  if (conflicts.length) throw new ConflictOfInterestError(conflicts);
  return {
    case: { ...c, assignee },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'case.assigned',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { assigneeId: assignee.id },
    },
  };
}

// ---------------------------------------------------------------------------
// Corrective actions outlive the case: closing requires a plan, not completion.
// ---------------------------------------------------------------------------

export function addAction(
  c: CaseState,
  input: { id: string; description: string; ownerId?: string; dueDate?: string },
  actor: Actor,
  now: string,
): Mutation {
  const access = canAccess(actor, c, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  assertValidId(input.id, 'action.id');
  return {
    case: {
      ...c,
      actions: [
        ...c.actions,
        {
          id: input.id,
          description: input.description,
          status: 'OPEN',
          ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        },
      ],
    },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'action.added',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { actionId: input.id },
    },
  };
}

/** Allowed in any state, including CLOSED and ARCHIVED: tracking continues after closure. */
export function completeAction(c: CaseState, actionId: string, actor: Actor, now: string): Mutation {
  const access = canAccess(actor, c, 'write');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  if (!c.actions.some((a) => a.id === actionId)) throw new AccessDeniedError('UNKNOWN_ACTION_ID');
  return {
    case: {
      ...c,
      actions: c.actions.map((a) => (a.id === actionId ? { ...a, status: 'DONE' as const, completedAt: now } : a)),
    },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'action.completed',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { actionId },
    },
  };
}

export function overdueActions(cases: CaseState[], nowIso: string): Array<{ caseId: string; actionId: string; ownerId: string; dueDate: string }> {
  const now = Date.parse(nowIso);
  const out: Array<{ caseId: string; actionId: string; ownerId: string; dueDate: string }> = [];
  for (const c of cases) {
    for (const a of c.actions) {
      if (a.status === 'OPEN' && a.ownerId && a.dueDate && Date.parse(a.dueDate) < now) {
        out.push({ caseId: c.id, actionId: a.id, ownerId: a.ownerId, dueDate: a.dueDate });
      }
    }
  }
  return out;
}
