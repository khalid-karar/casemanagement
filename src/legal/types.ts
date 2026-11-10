/**
 * Legal library. Laws are versioned, effective-dated, article-level data. Nothing reaches the AI
 * or a case-type rule until a human other than the uploader has VERIFIED it against the source.
 */
export type VerificationStatus = 'DRAFT' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUPERSEDED';

export interface Instrument {
  id: string;
  /** Platform baseline (tenantId null) or a tenant's own policy (e.g. work regulations). */
  tenantId: string | null;
  kind: 'LAW' | 'ROYAL_DECREE' | 'REGULATION' | 'STANDARD' | 'TENANT_POLICY';
  titleAr: string;
  titleEn?: string;
  issuer: string;
  sourceUrl?: string;
}

export interface Provision {
  /** Article label as written, e.g. "71" or "71 مكرر". */
  number: string;
  textAr: string;
  textEn?: string;
}

export interface InstrumentVersion {
  id: string;
  instrumentId: string;
  versionLabel: string;
  /** ISO date the text takes legal effect. */
  effectiveFrom: string;
  /** ISO date it stops being in force; null while current. */
  effectiveTo: string | null;
  amendedBy?: string;
  sourceHash: string;
  provisions: Provision[];
  status: VerificationStatus;
  uploadedBy: string;
  verifiedBy?: string;
  verifiedAt?: string;
  reviewNote?: string;
}

/** A case-type rule that implements a provision. Provision change => binding goes stale. */
export interface RuleBinding {
  id: string;
  caseTypeKey: string;
  ruleRef: string; // e.g. "transition:decide_penalty" or "clock:employee_grievance_window"
  instrumentId: string;
  provisionNumber: string;
  /** Hash of the provision text the rule was last approved against. */
  approvedTextHash: string;
  stale: boolean;
}

export interface LegalActor {
  id: string;
  roles: string[];
  tenantId: string;
}
