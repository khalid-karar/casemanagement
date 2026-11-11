import type { Principal } from './auth';

/**
 * The QA test-user matrix. ONE definition drives two things:
 *  - `AUTH_MODE=dev`: the in-process user switcher (src/api/server.ts).
 *  - the QA Keycloak realm: `pnpm gen:realm:qa` turns these into realm users.
 * So a wall that QA proves in dev mode is the same wall they re-prove through real sign-in.
 *
 * TEST DATA ONLY. The server refuses AUTH_MODE=dev when NODE_ENV=production, and the QA realm
 * is a separate file from the production realm (deploy/keycloak/cms-realm.json, which has no users).
 *
 * The matrix is built to make each wall provable with two accounts that differ in exactly one
 * attribute — see docs/handoff/QA-TEST-PLAN.md:
 *   tenant wall      a-hr-mgr   vs b-hr-mgr   (same role, different tenant)
 *   department wall  a-hr-mgr   vs a-sec-mgr  (same tenant, different department)
 *   read-across      a-sec-mgr  vs a-assurance (same department wall, one carries audit_assurance)
 *   privilege wall   a-counsel  vs a-aud-dir  (RESTRICTED clearance cannot reach a legal matter)
 *   clearance        a-hr-mgr   vs a-low      (same department, STANDARD clearance)
 *   sealed fields    a-hr-mgr   vs a-ethics   (only ethics_officer sees the reporter)
 *   external counsel a-ext-counsel is scoped to matter m-1 and nothing else
 */

export interface TestUser {
  id: string;
  name: string;
  tenantId: string;
  departments: Principal['departments'];
  roles: string[];
  clearance: Principal['clearance'];
  kind?: 'human' | 'external';
  counselMatterIds?: string[];
  /** Why this account exists. Printed by the seed script and quoted in the QA plan. */
  purpose: string;
}

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';
export const PLATFORM = 'platform';

export const TEST_USERS: TestUser[] = [
  // ---- tenant-a: a full client organisation ---------------------------------------------------
  { id: 'a-hr-intake', name: 'HR Intake (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['hr_intake'], clearance: 'RESTRICTED', purpose: 'Opens and triages HR cases; cannot assign or decide.' },
  { id: 'a-hr-mgr', name: 'HR Manager (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['hr_manager', 'hr_intake'], clearance: 'RESTRICTED', purpose: 'Main HR path: triage, assign, decide, notify, close.' },
  { id: 'a-hr-inv', name: 'HR Investigator (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['hr_investigator'], clearance: 'RESTRICTED', purpose: 'Investigates; must not be able to decide a penalty.' },
  { id: 'a-hr-dir', name: 'HR Director (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['hr_director'], clearance: 'RESTRICTED', purpose: 'Approver for a penalty decision (separation of duties).' },
  { id: 'a-ethics', name: 'Ethics Officer (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['ethics_officer'], clearance: 'RESTRICTED', purpose: 'The only account that may see a sealed reporter identity.' },
  { id: 'a-low', name: 'HR Clerk, low clearance (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['hr_intake'], clearance: 'STANDARD', purpose: 'STANDARD clearance: must be refused RESTRICTED cases in its own department.' },
  { id: 'a-sec-mgr', name: 'Security Manager (A)', tenantId: TENANT_A, departments: ['SECURITY'], roles: ['security_manager', 'security_intake'], clearance: 'RESTRICTED', purpose: 'Security path, and the far side of the HR/Security department wall.' },
  { id: 'a-sec-inv', name: 'Security Investigator (A)', tenantId: TENANT_A, departments: ['SECURITY'], roles: ['security_investigator'], clearance: 'RESTRICTED', purpose: 'Investigates security incidents.' },
  { id: 'a-sec-dir', name: 'Security Director (A)', tenantId: TENANT_A, departments: ['SECURITY'], roles: ['security_director'], clearance: 'RESTRICTED', purpose: 'Approver required to close a security incident.' },
  { id: 'a-aud-mgr', name: 'Audit Manager (A)', tenantId: TENANT_A, departments: ['AUDIT'], roles: ['audit_manager', 'auditor'], clearance: 'RESTRICTED', purpose: 'Raises and rates audit findings.' },
  { id: 'a-aud-dir', name: 'Audit Director (A)', tenantId: TENANT_A, departments: ['AUDIT'], roles: ['audit_director'], clearance: 'RESTRICTED', purpose: 'Closes audit findings; has no route into a legal matter.' },
  { id: 'a-assurance', name: 'Audit Assurance (A)', tenantId: TENANT_A, departments: ['AUDIT'], roles: ['audit_assurance'], clearance: 'RESTRICTED', purpose: 'Read-across: may READ other departments, redacted, never PRIVILEGED, never write.' },
  { id: 'a-counsel', name: 'In-house Counsel (A)', tenantId: TENANT_A, departments: ['LEGAL'], roles: ['legal_counsel', 'general_counsel', 'case_manager'], clearance: 'PRIVILEGED', purpose: 'Legal matters, legal hold, export. Holds general_counsel too, but approval must come from someone else: use a-gc.' },
  { id: 'a-gc', name: 'General Counsel (A)', tenantId: TENANT_A, departments: ['LEGAL'], roles: ['general_counsel'], clearance: 'PRIVILEGED', purpose: 'Second approver to close a legal matter (a-counsel cannot approve their own closure).' },
  { id: 'a-records', name: 'Records Officer (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['records_officer'], clearance: 'RESTRICTED', purpose: 'Archives closed cases; must be blocked by a legal hold.' },
  { id: 'a-admin', name: 'Client Admin (A)', tenantId: TENANT_A, departments: ['HR'], roles: ['tenant_admin'], clearance: 'RESTRICTED', purpose: 'Signs or withdraws the AI consent; reads the AI log.' },
  { id: 'a-ext-counsel', name: 'External Counsel (A, matter m-1)', tenantId: TENANT_A, departments: ['LEGAL'], roles: [], clearance: 'PRIVILEGED', kind: 'external', counselMatterIds: ['m-1'], purpose: 'Outside counsel: matter m-1 only, read/write only, no transitions.' },

  // ---- tenant-b: a second client, for isolation testing ---------------------------------------
  { id: 'b-hr-mgr', name: 'HR Manager (B)', tenantId: TENANT_B, departments: ['HR'], roles: ['hr_manager', 'hr_intake'], clearance: 'RESTRICTED', purpose: 'Identical rights to a-hr-mgr in another tenant: must see none of tenant-a.' },
  { id: 'b-counsel', name: 'In-house Counsel (B)', tenantId: TENANT_B, departments: ['LEGAL'], roles: ['legal_counsel', 'general_counsel'], clearance: 'PRIVILEGED', purpose: 'Highest clearance in tenant-b: still must see none of tenant-a.' },
  { id: 'b-admin', name: 'Client Admin (B)', tenantId: TENANT_B, departments: ['HR'], roles: ['tenant_admin'], clearance: 'RESTRICTED', purpose: 'Must not be able to change tenant-a’s AI settings or read its AI log.' },

  // ---- platform: our own staff, baseline national law only -------------------------------------
  { id: 'p-editor', name: 'Legal Content Editor (platform)', tenantId: PLATFORM, departments: ['LEGAL'], roles: ['legal_content_editor'], clearance: 'RESTRICTED', purpose: 'Uploads national law; must not be able to verify their own upload.' },
  { id: 'p-verifier', name: 'Legal Verifier (platform)', tenantId: PLATFORM, departments: ['LEGAL'], roles: ['legal_verifier'], clearance: 'RESTRICTED', purpose: 'Verifies a version uploaded by someone else (four-eyes).' },
];

export const asPrincipal = (u: TestUser): Principal => ({
  id: u.id,
  name: u.name,
  kind: u.kind ?? 'human',
  tenantId: u.tenantId,
  departments: u.departments,
  roles: u.roles,
  reportsTo: [],
  clearance: u.clearance,
  ...(u.counselMatterIds ? { counselMatterIds: u.counselMatterIds } : {}),
});
