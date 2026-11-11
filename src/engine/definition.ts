import { CaseTypeDefinition, type CaseTypeInput, type Guard } from './types';

function guardFieldRefs(g: Guard): string[] {
  const refs: string[] = [];
  if (g.when) refs.push(g.when.field);
  if (g.kind === 'field_present' || g.kind === 'field_in') refs.push(g.field);
  return refs;
}

/** Structural integrity checks a schema can't express. Returns a list of problems (empty = valid). */
export function validateCaseType(def: CaseTypeDefinition): string[] {
  const issues: string[] = [];

  const stateKeys = new Set<string>();
  for (const s of def.states) {
    if (stateKeys.has(s.key)) issues.push(`duplicate state "${s.key}"`);
    stateKeys.add(s.key);
  }
  const fieldByKey = new Map<string, CaseTypeDefinition['fields'][number]>();
  for (const f of def.fields) {
    if (fieldByKey.has(f.key)) issues.push(`duplicate field "${f.key}"`);
    fieldByKey.set(f.key, f);
    if (f.type === 'enum' && (!f.options || f.options.length === 0)) issues.push(`enum field "${f.key}" has no options`);
    // A misspelled state here is a silent bug: the field would simply never freeze.
    for (const s of f.lockedIn ?? []) {
      if (!stateKeys.has(s)) issues.push(`field "${f.key}" is lockedIn unknown state "${s}"`);
    }
    if (f.lockedFrom !== undefined && !stateKeys.has(f.lockedFrom)) {
      issues.push(`field "${f.key}" is lockedFrom unknown state "${f.lockedFrom}"`);
    }
  }

  if (!stateKeys.has(def.initialState)) issues.push(`initialState "${def.initialState}" is not a defined state`);

  const kindOf = new Map(def.states.map((s) => [s.key, s.kind]));
  const actions = new Set<string>();
  const edges = new Map<string, Set<string>>();

  for (const t of def.transitions) {
    if (actions.has(t.action)) issues.push(`duplicate action "${t.action}"`);
    actions.add(t.action);
    if (!stateKeys.has(t.to)) issues.push(`transition "${t.action}" targets unknown state "${t.to}"`);
    for (const from of t.from) {
      if (!stateKeys.has(from)) issues.push(`transition "${t.action}" starts from unknown state "${from}"`);
      if (kindOf.get(from) === 'ARCHIVED') issues.push(`ARCHIVED state "${from}" must have no outgoing transitions ("${t.action}")`);
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from)!.add(t.to);
    }
    for (const g of t.guards) {
      for (const ref of guardFieldRefs(g)) {
        if (!fieldByKey.has(ref)) issues.push(`guard on "${t.action}" references unknown field "${ref}"`);
      }
      // Typos in enum values are silent bugs: the guard would simply never match.
      const checks: Array<{ field: string; values: string[] }> = [];
      if (g.when) checks.push({ field: g.when.field, values: g.when.in });
      if (g.kind === 'field_in') checks.push({ field: g.field, values: g.values });
      for (const { field, values } of checks) {
        const def2 = fieldByKey.get(field);
        if (def2?.type === 'enum' && def2.options) {
          for (const v of values) {
            if (!def2.options.includes(v)) issues.push(`guard on "${t.action}" uses "${v}", not an option of "${field}"`);
          }
        }
      }
    }
  }

  // Every state must be reachable from the initial state, or the pack has dead code.
  const seen = new Set<string>([def.initialState]);
  const queue = [def.initialState];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of edges.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const key of stateKeys) if (!seen.has(key)) issues.push(`state "${key}" is unreachable`);

  for (const p of def.slaPolicies) if (!stateKeys.has(p.state)) issues.push(`SLA policy on unknown state "${p.state}"`);
  for (const key of Object.keys(def.sealedFieldRoles)) {
    if (!fieldByKey.has(key)) issues.push(`sealedFieldRoles names unknown field "${key}"`);
  }

  return issues;
}

/** Parse (filling defaults) and validate. Throws with every problem listed. */
export function defineCaseType(input: CaseTypeInput): CaseTypeDefinition {
  const def = CaseTypeDefinition.parse(input);
  const issues = validateCaseType(def);
  if (issues.length > 0) {
    throw new Error(`Invalid case type "${def.key}":\n - ${issues.join('\n - ')}`);
  }
  return def;
}
