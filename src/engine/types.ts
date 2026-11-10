import { z } from 'zod';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const Department = z.enum(['HR', 'SECURITY', 'AUDIT', 'LEGAL']);
export type Department = z.infer<typeof Department>;

export const Confidentiality = z.enum(['STANDARD', 'RESTRICTED', 'PRIVILEGED']);
export type Confidentiality = z.infer<typeof Confidentiality>;

export const CONFIDENTIALITY_RANK: Record<Confidentiality, number> = {
  STANDARD: 0,
  RESTRICTED: 1,
  PRIVILEGED: 2,
};

export const LocalizedText = z.object({
  en: z.string().min(1),
  ar: z.string().min(1),
});
export type LocalizedText = z.infer<typeof LocalizedText>;

// ---------------------------------------------------------------------------
// Case type definition: a case type is DATA. Departments are configured, not coded.
// ---------------------------------------------------------------------------

/** NORMAL: visible to anyone with access. PERSONAL: masked outside the home department.
 *  SEALED: visible only to the roles named in sealedFieldRoles (default: ethics_officer). */
export const Sensitivity = z.enum(['NORMAL', 'PERSONAL', 'SEALED']);

export const FieldDef = z.object({
  key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  label: LocalizedText,
  type: z.enum(['text', 'longtext', 'date', 'number', 'money', 'enum', 'boolean', 'person']),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  sensitivity: Sensitivity.default('NORMAL'),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const StateDef = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: LocalizedText,
  kind: z.enum(['OPEN', 'CLOSED', 'ARCHIVED']).default('OPEN'),
});
export type StateDef = z.infer<typeof StateDef>;

/** Optional condition: the guard only applies when the named field holds one of the listed values. */
const When = z.object({ field: z.string(), in: z.array(z.string()).min(1) });
const base = { when: When.optional() };

export const Guard = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('role'), anyOf: z.array(z.string()).min(1) }),
  z.object({ ...base, kind: z.literal('artifact_present'), artifactType: z.string(), message: LocalizedText }),
  /** Artifacts of these types must exist, created in this chronological order. */
  z.object({ ...base, kind: z.literal('artifact_sequence'), types: z.array(z.string()).min(2), message: LocalizedText }),
  /** At least one artifact of the type must carry attr within `in` / outside `notIn`. */
  z.object({
    ...base,
    kind: z.literal('artifact_attr'),
    artifactType: z.string(),
    attr: z.string(),
    in: z.array(z.string()).optional(),
    notIn: z.array(z.string()).optional(),
    message: LocalizedText,
  }),
  z.object({ ...base, kind: z.literal('field_present'), field: z.string(), message: LocalizedText }),
  z.object({ ...base, kind: z.literal('field_in'), field: z.string(), values: z.array(z.string()).min(1), message: LocalizedText }),
  /** A recorded approval for this role by someone other than the person acting. */
  z.object({ ...base, kind: z.literal('approval'), approverRole: z.string() }),
  z.object({ ...base, kind: z.literal('assignee_set') }),
  z.object({ ...base, kind: z.literal('no_conflict_of_interest') }),
  /** Every open corrective action has an owner and a due date. Completion is NOT required: actions outlive cases. */
  z.object({ ...base, kind: z.literal('actions_planned') }),
  /** Every evidence artifact carries a sha256 hash. */
  z.object({ ...base, kind: z.literal('evidence_integrity') }),
  z.object({ ...base, kind: z.literal('legal_hold_active') }),
  z.object({ ...base, kind: z.literal('not_on_legal_hold') }),
]);
export type Guard = z.infer<typeof Guard>;

export const TransitionDef = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: LocalizedText,
  from: z.array(z.string()).min(1),
  to: z.string(),
  guards: z.array(Guard).default([]),
});
export type TransitionDef = z.infer<typeof TransitionDef>;

/** Internal service-level target for a state. Tenant-configurable; not a legal claim. */
export const SlaPolicy = z.object({
  state: z.string(),
  businessDays: z.number().int().positive(),
  escalateToRole: z.string(),
});
export type SlaPolicy = z.infer<typeof SlaPolicy>;

/**
 * A statutory deadline. The engine never invents legal numbers: while a period is
 * unconfirmed by counsel, `days` MUST be null and the clock reports
 * AWAITING_COUNSEL_CONFIRMATION instead of a due date.
 */
export const StatutoryClock = z
  .object({
    key: z.string(),
    label: LocalizedText,
    legalBasis: z.string(),
    startsOnArtifact: z.string(),
    days: z.number().int().positive().nullable(),
    counting: z.enum(['CALENDAR', 'BUSINESS']),
    excludeOfficialHolidays: z.boolean().default(false),
    status: z.enum(['CONFIRMED', 'AWAITING_COUNSEL_CONFIRMATION']),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'AWAITING_COUNSEL_CONFIRMATION' && c.days !== null) {
      ctx.addIssue({ code: 'custom', message: 'unconfirmed statutory clock must have days = null', path: ['days'] });
    }
    if (c.status === 'CONFIRMED' && c.days === null) {
      ctx.addIssue({ code: 'custom', message: 'confirmed statutory clock must have a day count', path: ['days'] });
    }
  });
export type StatutoryClock = z.infer<typeof StatutoryClock>;

export const LegalReview = z.object({
  status: z.enum(['NOT_REQUIRED', 'DRAFT_PENDING_COUNSEL', 'COUNSEL_CONFIRMED']),
  items: z.array(z.string()).default([]),
});

export const CaseTypeDefinition = z.object({
  key: z.string().regex(/^[a-z]+\.[a-z_]+$/),
  version: z.number().int().positive(),
  domain: Department,
  label: LocalizedText,
  defaultConfidentiality: Confidentiality.default('RESTRICTED'),
  fields: z.array(FieldDef),
  states: z.array(StateDef).min(2),
  initialState: z.string(),
  transitions: z.array(TransitionDef).min(1),
  slaPolicies: z.array(SlaPolicy).default([]),
  statutoryClocks: z.array(StatutoryClock).default([]),
  sealedFieldRoles: z.record(z.string(), z.array(z.string())).default({}),
  /** null = the tenant must configure a retention period; purge stays disabled until then. */
  retentionYears: z.number().int().positive().nullable().default(null),
  legalReview: LegalReview.default({ status: 'NOT_REQUIRED', items: [] }),
});
export type CaseTypeDefinition = z.infer<typeof CaseTypeDefinition>;
export type CaseTypeInput = z.input<typeof CaseTypeDefinition>;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export type ActorKind = 'human' | 'ai' | 'system' | 'external';

export interface Actor {
  id: string;
  kind: ActorKind;
  tenantId: string;
  departments: Department[];
  roles: string[];
  /** Ids of the actor's management chain, nearest first. Used for conflict-of-interest checks. */
  reportsTo: string[];
  clearance: Confidentiality;
  /** External counsel only: matters they are instructed on. */
  counselMatterIds?: string[];
}

export type PartyRole = 'SUBJECT' | 'REPORTER' | 'WITNESS' | 'COMPLAINANT';

export interface Party {
  personId: string;
  role: PartyRole;
  reportsTo: string[];
  /** Sealed parties (e.g. an anonymous reporter) are hidden from everyone except ethics_officer. */
  sealed?: boolean;
}

export interface Artifact {
  id: string;
  type: string;
  createdAt: string;
  createdBy: string;
  hash?: string;
  payload?: Record<string, unknown>;
}

export interface Approval {
  role: string;
  approverId: string;
  at: string;
}

export interface CorrectiveAction {
  id: string;
  description: string;
  ownerId?: string;
  dueDate?: string;
  status: 'OPEN' | 'DONE';
  completedAt?: string;
}

export interface Assignee {
  id: string;
  reportsTo: string[];
}

export interface LegalHold {
  placedBy: string;
  placedAt: string;
  reason: string;
}

export interface CaseState {
  id: string;
  tenantId: string;
  caseTypeKey: string;
  caseTypeVersion: number;
  department: Department;
  state: string;
  stateEnteredAt: string;
  confidentiality: Confidentiality;
  fields: Record<string, unknown>;
  parties: Party[];
  assignee?: Assignee;
  artifacts: Artifact[];
  approvals: Approval[];
  actions: CorrectiveAction[];
  legalHold?: LegalHold;
  parentCaseId?: string;
  matterId?: string;
  createdBy: string;
  createdAt: string;
  closedAt?: string;
}

export interface Blocker {
  code: string;
  message: string;
  messageAr?: string;
}

export interface Evaluation {
  allowed: boolean;
  blockers: Blocker[];
  transition?: TransitionDef;
}
