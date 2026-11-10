import { appendEvent, verifyChain } from '../engine';
import type { AuditEvent, AuditEventInput, CaseState } from '../engine';
import { LegalLibrary } from '../legal';

/** In-memory store behind a narrow interface; the Postgres implementation replaces it without touching routes. */
export class Store {
  cases = new Map<string, CaseState>();
  audit = new Map<string, AuditEvent[]>();
  library = new LegalLibrary();

  save(c: CaseState, ev: AuditEventInput) {
    this.cases.set(c.id, c);
    this.audit.set(c.id, appendEvent(this.audit.get(c.id) ?? [], ev) as AuditEvent[]);
  }
  verify(caseId: string) { return verifyChain(this.audit.get(caseId) ?? []); }
}
