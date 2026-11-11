import type { Mutation } from './workflow';
import { AccessDeniedError } from './workflow';
import { canAccess } from './permissions';
import { FieldError, assertValidId, validateFields } from './fields';
import { canonicalJson, sha256Hex } from './canonical';
import type { Actor, Amendment, CaseState, CaseTypeDefinition } from './types';

/**
 * Post-closure corrections.
 *
 * Once a case is CLOSED or ARCHIVED every field is frozen, which is what makes the file defensible.
 * But a frozen file with no correction route is its own problem: a misspelled name or a wrong date
 * stays wrong forever, and PDPL gives a data subject the right to have inaccurate personal data
 * corrected. An amendment resolves both. It does NOT edit the field — `fields` keeps exactly what it
 * said at closure — it appends a dated, attributed, reasoned correction beside it.
 *
 * So a reader of an amended case sees both the original and the correction, which is what a court or
 * an auditor wants: the fact that a record was corrected is itself evidence, and hiding it by
 * overwriting would be the suspicious act.
 */

const MAX_REASON = 2000;
const MIN_REASON = 10;

/** The states where amending is the right tool. While a case is open, edit the field instead. */
function closed(def: CaseTypeDefinition, c: CaseState): boolean {
  return (def.states.find((s) => s.key === c.state)?.kind ?? 'OPEN') !== 'OPEN';
}

export function amendCase(
  c: CaseState,
  input: { id: string; field: string; correctedValue: unknown; reason: string },
  actor: Actor,
  now: string,
  def: CaseTypeDefinition,
): Mutation {
  const access = canAccess(actor, c, 'amend');
  if (!access.allowed) throw new AccessDeniedError(access.reason ?? 'NO_ACCESS');

  assertValidId(input.id, 'amendment.id');
  if ((c.amendments ?? []).some((a) => a.id === input.id)) throw new AccessDeniedError('AMENDMENT_ID_EXISTS');

  // An open case has an ordinary edit path, and using both would give two competing truths.
  if (!closed(def, c)) throw new FieldError('VALIDATION', [{ field: input.field, code: 'CASE_NOT_CLOSED' }]);

  const fd = def.fields.find((f) => f.key === input.field);
  if (!fd) throw new FieldError('VALIDATION', [{ field: input.field, code: 'UNKNOWN_FIELD' }]);
  // Same shape rules as an ordinary edit: a correction may not be a value the field could never hold.
  validateFields(def, { [input.field]: input.correctedValue });
  if (input.correctedValue === null || input.correctedValue === undefined) {
    throw new FieldError('VALIDATION', [{ field: input.field, code: 'CORRECTED_VALUE_REQUIRED' }]);
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
    throw new FieldError('VALIDATION', [{ field: 'reason', code: 'REASON_REQUIRED' }]);
  }

  // A sealed field keeps its sealed roles after closure: amendment is not a way around the seal.
  if (fd.sensitivity === 'SEALED') {
    const allowed = def.sealedFieldRoles[input.field] ?? ['ethics_officer'];
    if (!actor.roles.some((r) => allowed.includes(r))) throw new AccessDeniedError(`SEALED_FIELD_WRITE:${input.field}`);
  }

  const original = c.fields[input.field] ?? null;
  if (canonicalJson(original) === canonicalJson(input.correctedValue)) {
    throw new FieldError('VALIDATION', [{ field: input.field, code: 'NO_CHANGE' }]);
  }

  const amendment: Amendment = {
    id: input.id,
    field: input.field,
    originalValue: original,
    correctedValue: input.correctedValue,
    reason,
    authorId: actor.id,
    at: now,
  };

  return {
    case: { ...c, amendments: [...(c.amendments ?? []), amendment] },
    event: {
      caseId: c.id,
      tenantId: c.tenantId,
      type: 'case.amended',
      actorId: actor.id,
      actorKind: actor.kind,
      at: now,
      // Same rule as a field edit: the audit log never becomes a second copy of a personal value.
      payload:
        fd.sensitivity === 'NORMAL'
          ? { amendmentId: input.id, field: input.field, from: original, to: input.correctedValue, reason }
          : {
              amendmentId: input.id,
              field: input.field,
              fromSha256: sha256Hex(canonicalJson(original)),
              toSha256: sha256Hex(canonicalJson(input.correctedValue)),
              reason,
            },
    },
  };
}

/**
 * The value a reader should show for a field: the latest correction if one exists, else the original.
 * Callers that render a case file for court or export should show BOTH, not just this.
 */
export function effectiveField(c: CaseState, key: string): unknown {
  const latest = (c.amendments ?? []).filter((a) => a.field === key).at(-1);
  return latest ? latest.correctedValue : c.fields[key];
}
