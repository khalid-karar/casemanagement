import type { CaseTypeDefinition } from '../engine/types';
import type { LegalLibrary, LegalActor } from '../legal';
import { CASE_TYPES } from './index';

/** Platform-baseline instrument ids used by the bindings below. */
export const LABOUR_LAW = 'sa-labour-law';
export const PDPL = 'sa-pdpl';

export interface RuleSource {
  caseTypeKey: string;
  /** transition:<action> | clock:<key> | field:<key> | platform:<name> */
  ruleRef: string;
  instrumentId: string;
  provisionNumber: string;
  why: string;
}

/**
 * Which verified article each rule implements. Only mappings we are confident of are listed.
 * Security and Audit have none yet: they are driven by internal policy and professional
 * standards (IIA 2024, ISO) whose article mapping counsel/audit SMEs must supply, not guess.
 */
export const RULE_SOURCES: RuleSource[] = [
  { caseTypeKey: 'hr.misconduct', ruleRef: 'transition:decide_penalty', instrumentId: LABOUR_LAW, provisionNumber: '71', why: 'Art. 71 procedure before a penalty' },
  { caseTypeKey: 'hr.misconduct', ruleRef: 'transition:decide_minor_penalty', instrumentId: LABOUR_LAW, provisionNumber: '71', why: 'Art. 71 oral-questioning exception' },
  { caseTypeKey: 'hr.misconduct', ruleRef: 'field:penaltyType', instrumentId: LABOUR_LAW, provisionNumber: '66', why: 'Art. 66 permitted penalties' },
  { caseTypeKey: 'hr.misconduct', ruleRef: 'transition:notify_penalty', instrumentId: LABOUR_LAW, provisionNumber: '72', why: 'Art. 72 written notice of penalty' },
  { caseTypeKey: 'hr.misconduct', ruleRef: 'clock:employee_grievance_window', instrumentId: LABOUR_LAW, provisionNumber: '72', why: 'Art. 72 grievance period' },
  { caseTypeKey: 'hr.misconduct', ruleRef: 'clock:employer_grievance_response_window', instrumentId: LABOUR_LAW, provisionNumber: '72', why: 'Art. 72 response period' },
  { caseTypeKey: 'platform', ruleRef: 'platform:ai-inference-hosting', instrumentId: PDPL, provisionNumber: '29', why: 'Art. 29 cross-border transfer: in-Kingdom inference' },
];

/** A ruleRef must point at something real in the case type, or the binding guards nothing. */
export function ruleExists(def: CaseTypeDefinition, ref: string): boolean {
  const [kind, name] = ref.split(':') as [string, string];
  if (kind === 'transition') return def.transitions.some((t) => t.action === name);
  if (kind === 'clock') return def.statutoryClocks.some((c) => c.key === name);
  if (kind === 'field') return def.fields.some((f) => f.key === name);
  return false;
}

export function invalidSources(): string[] {
  return RULE_SOURCES.filter((s) => s.caseTypeKey !== 'platform' && (!CASE_TYPES[s.caseTypeKey] || !ruleExists(CASE_TYPES[s.caseTypeKey]!, s.ruleRef)))
    .map((s) => `${s.caseTypeKey} ${s.ruleRef}`);
}

export const bindingId = (s: RuleSource) => `${s.caseTypeKey}|${s.ruleRef}`;

/**
 * Counsel-triggered: bind every rule whose article is verified and in force on `at`.
 * Rules whose law has not been verified yet are returned as pending, never silently bound.
 */
export function syncBindings(lib: LegalLibrary, counsel: LegalActor, at: string) {
  const bound: string[] = [];
  const pending: string[] = [];
  for (const s of RULE_SOURCES) {
    if (lib.bindings.has(bindingId(s))) continue;
    try {
      lib.bindRule({ id: bindingId(s), caseTypeKey: s.caseTypeKey, ruleRef: s.ruleRef, instrumentId: s.instrumentId, provisionNumber: s.provisionNumber }, counsel, at);
      bound.push(bindingId(s));
    } catch (e) {
      if ((e as Error).message === 'PROVISION_NOT_VERIFIED_IN_FORCE' || (e as Error).message === 'UNKNOWN_INSTRUMENT') pending.push(bindingId(s));
      else throw e;
    }
  }
  return { bound, pending };
}

export interface CaseTypeLegalStatus {
  caseTypeKey: string;
  /** Statutory rules this type should be bound to. */
  expected: number;
  bound: number;
  stale: string[];
  unbound: string[];
  /** READY only when every expected rule is bound and none is stale. */
  status: 'READY' | 'NEEDS_COUNSEL' | 'NO_STATUTORY_RULES_MAPPED';
}

export function legalStatus(lib: LegalLibrary, caseTypeKey: string): CaseTypeLegalStatus {
  const expected = RULE_SOURCES.filter((s) => s.caseTypeKey === caseTypeKey);
  const b = expected.map((s) => ({ s, binding: lib.bindings.get(bindingId(s)) }));
  const stale = b.filter((x) => x.binding?.stale).map((x) => x.s.ruleRef);
  const unbound = b.filter((x) => !x.binding).map((x) => x.s.ruleRef);
  return {
    caseTypeKey, expected: expected.length, bound: b.filter((x) => x.binding).length, stale, unbound,
    status: expected.length === 0 ? 'NO_STATUTORY_RULES_MAPPED' : stale.length || unbound.length ? 'NEEDS_COUNSEL' : 'READY',
  };
}
