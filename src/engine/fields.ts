import { canonicalJson, sha256Hex } from './canonical';
import type { Actor, CaseState, CaseTypeDefinition, FieldDef } from './types';
import { REDACTED } from './permissions';

/**
 * Field rules. One place decides what may be written to a case field, so the API, the engine and the
 * tests all agree:
 *   1. Shape      only fields the case type defines, with the right type, enum value and length.
 *   2. Lock       nothing is editable once a case is CLOSED or ARCHIVED; a field can also freeze earlier
 *                 (`lockedIn`, e.g. the penalty decision freezes when the case is DECIDED).
 *   3. Sealed     a SEALED field is write-once for everyone except its sealed roles: staff taking a report
 *                 may record it, nobody without the role may replace what is there.
 *   4. Audit      every change is recorded with old and new value; PERSONAL and SEALED values are recorded
 *                 as SHA-256 only, so the audit log never becomes a second copy of the secret.
 */
export class FieldError extends Error {
  constructor(
    /** VALIDATION → 400, LOCKED → 409. */
    public readonly kind: 'VALIDATION' | 'LOCKED',
    public readonly problems: { field: string; code: string }[],
  ) {
    super(`Field ${kind.toLowerCase()}: ${problems.map((p) => `${p.field}:${p.code}`).join(', ')}`);
    this.name = 'FieldError';
  }
}

/** Ids are machine identifiers chosen by clients: keep them short and boring so they are safe everywhere. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export function assertValidId(id: unknown, what = 'id'): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new FieldError('VALIDATION', [{ field: what, code: 'INVALID_ID' }]);
}

const MAX_TEXT = 500;
const MAX_LONGTEXT = 20_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isRealDate = (s: string) => {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
};

function check(def: FieldDef, v: unknown): string | undefined {
  if (typeof v === 'string' && v === REDACTED) return 'REDACTED_MARKER'; // a masked value echoed back must never overwrite the real one
  switch (def.type) {
    case 'text': return typeof v === 'string' && v.length <= MAX_TEXT ? undefined : 'EXPECTED_TEXT';
    case 'longtext': return typeof v === 'string' && v.length <= MAX_LONGTEXT ? undefined : 'EXPECTED_LONGTEXT';
    case 'person': return typeof v === 'string' && v.length > 0 && v.length <= 200 ? undefined : 'EXPECTED_PERSON_ID';
    case 'date': return typeof v === 'string' && isRealDate(v) ? undefined : 'EXPECTED_DATE_YYYY_MM_DD';
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? undefined : 'EXPECTED_NUMBER';
    case 'money': return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? undefined : 'EXPECTED_NON_NEGATIVE_NUMBER';
    case 'boolean': return typeof v === 'boolean' ? undefined : 'EXPECTED_BOOLEAN';
    case 'enum': return typeof v === 'string' && (def.options ?? []).includes(v) ? undefined : 'NOT_AN_ALLOWED_OPTION';
  }
}

/** Shape check only (no state, no roles). Used on create and on edit. */
export function validateFields(def: CaseTypeDefinition, fields: Record<string, unknown>): void {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new FieldError('VALIDATION', [{ field: '*', code: 'EXPECTED_OBJECT' }]);
  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  const problems: { field: string; code: string }[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const fd = byKey.get(k);
    if (!fd) { problems.push({ field: k, code: 'UNKNOWN_FIELD' }); continue; }
    if (v === null) continue; // null means "clear this field" (edit) or "not provided" (create)
    const bad = check(fd, v);
    if (bad) problems.push({ field: k, code: bad });
  }
  if (problems.length) throw new FieldError('VALIDATION', problems);
}

/** Whether the case's current state freezes this field. */
export function lockedBy(def: CaseTypeDefinition, c: CaseState, f: FieldDef): string | undefined {
  const kind = def.states.find((s) => s.key === c.state)?.kind ?? 'OPEN';
  if (kind !== 'OPEN') return 'CASE_CLOSED';
  if (f.lockedIn?.includes(c.state)) return 'FIELD_LOCKED_IN_STATE';
  return undefined;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const digest = (v: unknown) => (v === undefined ? null : sha256Hex(canonicalJson(v)));

export interface FieldChanges { [key: string]: { from?: unknown; to?: unknown; fromSha256?: string | null; toSha256?: string | null } }

/**
 * Validates a patch against the case type, the case's state and the actor's roles, and returns what
 * actually changes plus the audit-safe description of it. Throws FieldError / returns denial reasons via throw.
 */
export function planFieldEdit(
  def: CaseTypeDefinition, c: CaseState, patch: Record<string, unknown>, actor: Actor,
): { next: Record<string, unknown>; changes: FieldChanges; deniedSealed: string[] } {
  validateFields(def, patch);
  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  const locked: { field: string; code: string }[] = [];
  const deniedSealed: string[] = [];
  const next = { ...c.fields };
  const changes: FieldChanges = {};

  for (const [k, v] of Object.entries(patch)) {
    const f = byKey.get(k)!;
    if (same(c.fields[k], v)) continue; // no-op: no change, no audit noise
    const why = lockedBy(def, c, f);
    if (why) { locked.push({ field: k, code: why }); continue; }
    if (f.sensitivity === 'SEALED') {
      const allowed = def.sealedFieldRoles[k] ?? ['ethics_officer'];
      const existing = c.fields[k];
      const has = existing !== undefined && existing !== null && existing !== '';
      if (has && !actor.roles.some((r) => allowed.includes(r))) { deniedSealed.push(k); continue; }
    }
    if (v === null) delete next[k]; else next[k] = v;
    changes[k] = f.sensitivity === 'NORMAL'
      ? { from: c.fields[k] ?? null, to: v }
      : { fromSha256: digest(c.fields[k]), toSha256: digest(v) };
  }
  if (locked.length) throw new FieldError('LOCKED', locked);
  return { next, changes, deniedSealed };
}
