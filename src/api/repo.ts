import { appendEvent, verifyChain } from '../engine';
import type { AuditEvent, AuditEventInput, CaseState } from '../engine';
import { LegalLibrary } from '../legal';

/** Everything inside one tenant-scoped transaction. */
export interface Tx {
  getCase(id: string, lock?: boolean): Promise<CaseState | undefined>;
  listCases(): Promise<CaseState[]>;
  /** create=true inserts (fails if the id exists); otherwise updates. Appends the audit event atomically. */
  saveCase(c: CaseState, ev: AuditEventInput, create?: boolean): Promise<void>;
  getAudit(caseId: string): Promise<AuditEvent[]>;
}

export interface Repo {
  /** Runs fn in a transaction bound to one tenant; row-level security applies in Postgres. */
  tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Legal library access scoped to the caller's tenant. 'write' serialises writers and persists changes.
   * The library instance is fresh per call, so no state is shared between requests or servers.
   */
  lib<T>(tenantId: string, mode: 'read' | 'write', fn: (lib: LegalLibrary) => Promise<T> | T): Promise<T>;
  putFile(tenantId: string, f: { sha256: string; name: string; bytes: Uint8Array; uploadedBy: string }): Promise<void>;
  verifyChain(events: AuditEvent[]): ReturnType<typeof verifyChain>;
  close?(): Promise<void>;
}

/** In-memory repo for tests and local demos. */
export class MemoryRepo implements Repo {
  private cases = new Map<string, CaseState>();
  private audit = new Map<string, AuditEvent[]>();
  private library = new LegalLibrary();
  files = new Map<string, { name: string; bytes: Uint8Array; uploadedBy: string }>();
  private k = (t: string, id: string) => `${t}\u0000${id}`;

  async tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const self = this;
    return fn({
      async getCase(id) { return self.cases.get(self.k(tenantId, id)); },
      async listCases() { return [...self.cases.values()].filter((c) => c.tenantId === tenantId); },
      async saveCase(c, ev, create) {
        if (c.tenantId !== tenantId) throw new Error('TENANT_MISMATCH');
        if (create && self.cases.has(self.k(tenantId, c.id))) throw new Error('CASE_EXISTS');
        self.cases.set(self.k(tenantId, c.id), c);
        self.audit.set(self.k(tenantId, c.id), appendEvent(self.audit.get(self.k(tenantId, c.id)) ?? [], ev));
      },
      async getAudit(id) { return self.audit.get(self.k(tenantId, id)) ?? []; },
    });
  }
  async lib<T>(_t: string, _m: 'read' | 'write', fn: (lib: LegalLibrary) => Promise<T> | T) { return fn(this.library); }
  async putFile(_t: string, f: { sha256: string; name: string; bytes: Uint8Array; uploadedBy: string }) { this.files.set(f.sha256, f); }
  verifyChain(e: AuditEvent[]) { return verifyChain(e); }
}
