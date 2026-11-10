import {
  CONFIDENTIALITY_RANK,
  type Actor,
  type CaseState,
  type CaseTypeDefinition,
  type Confidentiality,
  type Department,
} from './types';

/**
 * Permission model: attribute-based, deny by default, with walls.
 *  - Tenant wall: nothing crosses tenants.
 *  - Department wall: HR, Security, Audit and Legal cannot see each other's cases. A referral
 *    hands over a scoped packet; it never grants access.
 *  - Privilege wall: PRIVILEGED material is visible only to Legal and to assigned external counsel.
 *  - Audit assurance read-across: role audit_assurance may READ non-privileged cases elsewhere,
 *    always through field-level redaction (see redactForActor).
 */
export type Action = 'read' | 'write' | 'transition' | 'refer' | 'export' | 'manage_hold';

export interface ResourceRef {
  tenantId: string;
  department: Department;
  confidentiality: Confidentiality;
  matterId?: string | undefined;
}

export interface Decision {
  allowed: boolean;
  reason?: string;
}

const ALLOW: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

export function canAccess(actor: Actor, res: ResourceRef, action: Action): Decision {
  if (actor.tenantId !== res.tenantId) return deny('TENANT_MISMATCH');
  if (actor.kind === 'ai' && action !== 'read') return deny('AI_READ_ONLY');

  if (actor.kind === 'external') {
    if (!res.matterId || !actor.counselMatterIds?.includes(res.matterId)) return deny('EXTERNAL_NOT_ASSIGNED');
    if (action !== 'read' && action !== 'write') return deny('EXTERNAL_ACTION_NOT_PERMITTED');
    return ALLOW;
  }

  const home = actor.departments.includes(res.department);
  const assuranceReadAcross =
    action === 'read' && actor.roles.includes('audit_assurance') && res.confidentiality !== 'PRIVILEGED';
  if (!home && !assuranceReadAcross) return deny('DEPARTMENT_WALL');

  if (CONFIDENTIALITY_RANK[actor.clearance] < CONFIDENTIALITY_RANK[res.confidentiality]) {
    return deny('INSUFFICIENT_CLEARANCE');
  }
  if (res.confidentiality === 'PRIVILEGED' && !actor.departments.includes('LEGAL')) return deny('PRIVILEGE_WALL');

  if (action === 'manage_hold' && !actor.roles.includes('legal_counsel')) return deny('ROLE_REQUIRED:legal_counsel');
  if (action === 'export' && !(actor.roles.includes('case_manager') || actor.roles.includes('legal_counsel'))) {
    return deny('ROLE_REQUIRED:case_manager');
  }
  return ALLOW;
}

export const REDACTED = '[REDACTED]';

/**
 * Field-level redaction. Returns a copy; the stored case is never altered.
 *  - SEALED fields and sealed parties: only ethics_officer (or the roles in sealedFieldRoles).
 *  - PERSONAL fields and party identities: masked for anyone outside the home department.
 */
export function redactForActor(def: CaseTypeDefinition, c: CaseState, actor: Actor): CaseState {
  const sees = actor.departments.includes(c.department) || actor.kind === 'external';
  const fields: Record<string, unknown> = { ...c.fields };

  for (const f of def.fields) {
    if (!(f.key in fields)) continue;
    if (f.sensitivity === 'SEALED') {
      const allowedRoles = def.sealedFieldRoles[f.key] ?? ['ethics_officer'];
      if (!actor.roles.some((r) => allowedRoles.includes(r))) fields[f.key] = REDACTED;
    } else if (f.sensitivity === 'PERSONAL' && !sees) {
      fields[f.key] = REDACTED;
    }
  }

  const parties = c.parties
    .filter((p) => !p.sealed || actor.roles.includes('ethics_officer'))
    .map((p) => (sees ? p : { ...p, personId: REDACTED, reportsTo: [] }));

  return { ...c, fields, parties };
}
