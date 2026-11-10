import { canonicalJson, sha256Hex } from './canonical';
import type { AuditEventInput } from './audit';
import { type EvidenceItem, verifyCustody } from './evidence';
import { canAccess } from './permissions';
import type { Actor, CaseState, CaseTypeDefinition, Department, PartyRole } from './types';
import { AccessDeniedError } from './workflow';

/**
 * Referral, not access. When Security hands a theft to HR, or Audit hands fraud indicators to
 * Security, the receiving department gets a scoped, hashed packet in a NEW linked case. It
 * never gains access to the source case.
 */
export class ReferralError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ReferralError';
  }
}

export interface ReferralRequest {
  targetDepartment: Department;
  targetCaseTypeKey: string;
  includeFields: string[];
  evidenceIds: string[];
  reason: string;
}

export interface ReferralPacket {
  id: string;
  sourceCaseId: string;
  tenantId: string;
  sourceDepartment: Department;
  targetDepartment: Department;
  targetCaseTypeKey: string;
  reason: string;
  fields: Record<string, unknown>;
  subjects: Array<{ personId: string; role: PartyRole; reportsTo: string[] }>;
  evidence: Array<{ id: string; filename: string; sha256: string }>;
  createdBy: string;
  createdAt: string;
  packetHash: string;
}

function hashPacket(p: Omit<ReferralPacket, 'packetHash'>): string {
  return sha256Hex(canonicalJson(p));
}

export function buildReferralPacket(
  def: CaseTypeDefinition,
  source: CaseState,
  actor: Actor,
  req: ReferralRequest,
  evidence: EvidenceItem[],
  packetId: string,
  now: string,
): ReferralPacket {
  const access = canAccess(actor, source, 'refer');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');
  if (req.targetDepartment === source.department) throw new ReferralError('SAME_DEPARTMENT', 'Refer to a different department');
  if (source.confidentiality === 'PRIVILEGED') {
    throw new ReferralError('PRIVILEGED_NOT_REFERABLE', 'Privileged material never leaves counsel through a referral');
  }

  const fields: Record<string, unknown> = {};
  for (const key of req.includeFields) {
    const f = def.fields.find((x) => x.key === key);
    if (!f) throw new ReferralError('UNKNOWN_FIELD', `"${key}" is not a field of ${def.key}`);
    if (f.sensitivity === 'SEALED') throw new ReferralError('SEALED_FIELD_NOT_REFERABLE', `"${key}" is sealed and cannot be referred`);
    if (key in source.fields) fields[key] = source.fields[key];
  }

  const items: ReferralPacket['evidence'] = [];
  for (const id of req.evidenceIds) {
    const e = evidence.find((x) => x.id === id);
    if (!e || e.caseId !== source.id || e.tenantId !== source.tenantId) {
      throw new ReferralError('EVIDENCE_NOT_IN_CASE', `Evidence "${id}" does not belong to this case`);
    }
    if (!verifyCustody(e)) throw new ReferralError('CUSTODY_BROKEN', `Chain of custody for "${id}" does not verify`);
    items.push({ id: e.id, filename: e.filename, sha256: e.sha256 });
  }

  // Only unsealed subjects travel. Reporters and witnesses never do.
  const subjects = source.parties
    .filter((p) => p.role === 'SUBJECT' && !p.sealed)
    .map((p) => ({ personId: p.personId, role: p.role, reportsTo: p.reportsTo }));

  const partial: Omit<ReferralPacket, 'packetHash'> = {
    id: packetId,
    sourceCaseId: source.id,
    tenantId: source.tenantId,
    sourceDepartment: source.department,
    targetDepartment: req.targetDepartment,
    targetCaseTypeKey: req.targetCaseTypeKey,
    reason: req.reason,
    fields,
    subjects,
    evidence: items,
    createdBy: actor.id,
    createdAt: now,
  };
  return { ...partial, packetHash: hashPacket(partial) };
}

export function verifyReferralPacket(p: ReferralPacket): boolean {
  const { packetHash, ...rest } = p;
  return hashPacket(rest) === packetHash;
}

export interface ReferralResult {
  child: CaseState;
  childEvent: AuditEventInput;
  sourceEvent: AuditEventInput;
}

/**
 * Opens the linked child case in the target department. The packet is stored as a hashed
 * artifact. The referring actor needs no access to the target department to do this.
 */
export function createChildCaseFromReferral(
  packet: ReferralPacket,
  targetDef: CaseTypeDefinition,
  childId: string,
  actor: Actor,
  now: string,
): ReferralResult {
  if (!verifyReferralPacket(packet)) throw new ReferralError('PACKET_TAMPERED', 'Packet hash does not verify');
  if (targetDef.domain !== packet.targetDepartment || targetDef.key !== packet.targetCaseTypeKey) {
    throw new ReferralError('TARGET_MISMATCH', 'Packet was not addressed to this case type');
  }
  if (actor.tenantId !== packet.tenantId) throw new AccessDeniedError('TENANT_MISMATCH');

  const child: CaseState = {
    id: childId,
    tenantId: packet.tenantId,
    caseTypeKey: targetDef.key,
    caseTypeVersion: targetDef.version,
    department: targetDef.domain,
    state: targetDef.initialState,
    stateEnteredAt: now,
    confidentiality: targetDef.defaultConfidentiality,
    fields: {},
    parties: packet.subjects.map((s) => ({ personId: s.personId, role: s.role, reportsTo: s.reportsTo })),
    artifacts: [
      {
        id: `${childId}-referral`,
        type: 'referral_packet',
        createdAt: now,
        createdBy: actor.id,
        hash: packet.packetHash,
        payload: { packet },
      },
    ],
    approvals: [],
    actions: [],
    parentCaseId: packet.sourceCaseId,
    ...(targetDef.domain === 'LEGAL' ? { matterId: childId } : {}),
    createdBy: actor.id,
    createdAt: now,
  };

  return {
    child,
    childEvent: {
      caseId: childId,
      tenantId: packet.tenantId,
      type: 'case.created_from_referral',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: { parentCaseId: packet.sourceCaseId, packetHash: packet.packetHash },
    },
    sourceEvent: {
      caseId: packet.sourceCaseId,
      tenantId: packet.tenantId,
      type: 'case.referred',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      payload: {
        targetDepartment: packet.targetDepartment,
        childCaseId: childId,
        packetHash: packet.packetHash,
        evidenceCount: packet.evidence.length,
      },
    },
  };
}
