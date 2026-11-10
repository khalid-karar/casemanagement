import { appendEvent, verifyChain } from '../engine';
import type { Actor, AuditEvent, AuditEventInput, CaseState } from '../engine';
import { LegalLibrary } from '../legal';
import type { KeyStore, TenantKey } from '../security/crypto';
import type { AiSettings } from '../ai/consent';
import { defaultSettings } from '../ai/consent';

export interface CaseDocument { sha256: string; name: string; mime: string; bytes: Uint8Array; uploadedBy: string; uploadedAt: string }

export interface AiLogEntry { at: string; actorId: string; type: string; data: Record<string, unknown> }

/** Everything inside one tenant-scoped transaction. */
/**
 * Who a transaction acts for. A signed-in person (an Actor) gets the department, clearance and privilege walls enforced by the
 * database as well as by the application. A bare tenant id is a trusted internal job (tenant isolation only).
 */
export type Scope = string | Pick<Actor, 'tenantId' | 'kind' | 'departments' | 'roles' | 'clearance' | 'counselMatterIds'>;
export const tenantOf = (s: Scope) => (typeof s === 'string' ? s : s.tenantId);

export interface Tx {
  getCase(id: string, lock?: boolean): Promise<CaseState | undefined>;
  listCases(): Promise<CaseState[]>;
  /** create=true inserts (fails if the id exists); otherwise updates. Appends the audit event atomically. */
  saveCase(c: CaseState, ev: AuditEventInput, create?: boolean): Promise<void>;
  getAudit(caseId: string): Promise<AuditEvent[]>;
}

export interface Repo extends KeyStore {
  /** Runs fn in a transaction bound to one tenant; row-level security applies in Postgres. */
  tx<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Legal library access scoped to the caller's tenant. 'write' serialises writers and persists changes.
   * The library instance is fresh per call, so no state is shared between requests or servers.
   */
  lib<T>(tenantId: string, mode: 'read' | 'write', fn: (lib: LegalLibrary) => Promise<T> | T): Promise<T>;
  putFile(tenantId: string, f: { sha256: string; name: string; bytes: Uint8Array; uploadedBy: string }): Promise<void>;
  /** Stores a case document under its SHA-256. Idempotent: the same bytes for the same case are stored once. */
  putCaseDocument(scope: Scope, caseId: string, doc: CaseDocument): Promise<void>;
  getCaseDocument(scope: Scope, caseId: string, sha256: string): Promise<CaseDocument | undefined>;
  getAiSettings(tenantId: string): Promise<AiSettings>;
  /** Saves the settings and appends the log entry in one transaction. */
  saveAiSettings(tenantId: string, s: AiSettings, entry: AiLogEntry): Promise<void>;
  logAi(tenantId: string, entry: AiLogEntry): Promise<void>;
  listAiLog(tenantId: string, limit: number): Promise<AiLogEntry[]>;
  verifyChain(events: AuditEvent[]): ReturnType<typeof verifyChain>;
  close?(): Promise<void>;
}

/** In-memory repo for tests and local demos. */
export class MemoryRepo implements Repo {
  private cases = new Map<string, CaseState>();
  private audit = new Map<string, AuditEvent[]>();
  private library = new LegalLibrary();
  files = new Map<string, { name: string; bytes: Uint8Array; uploadedBy: string }>();
  private docs = new Map<string, CaseDocument>();
  private keys = new Map<string, TenantKey[]>();
  async getTenantKeys(t: string) { return [...(this.keys.get(t) ?? [])].sort((a, b) => a.version - b.version); }
  async putTenantKey(t: string, k: TenantKey) { const cur = this.keys.get(t) ?? []; if (cur.some((x) => x.version === k.version)) return false; this.keys.set(t, [...cur, k]); return true; }
  async putCaseDocument(sc: Scope, caseId: string, d: CaseDocument) { const t = tenantOf(sc); const k = `${t}\u0000${caseId}\u0000${d.sha256}`; if (!this.docs.has(k)) this.docs.set(k, d); }
  async getCaseDocument(sc: Scope, caseId: string, sha256: string) { const t = tenantOf(sc); return this.docs.get(`${t}\u0000${caseId}\u0000${sha256}`); }
  private ai = new Map<string, AiSettings>();
  private aiLog = new Map<string, AiLogEntry[]>();
  async getAiSettings(t: string) { return this.ai.get(t) ?? defaultSettings(t); }
  async saveAiSettings(t: string, s: AiSettings, e: AiLogEntry) { this.ai.set(t, s); await this.logAi(t, e); }
  async logAi(t: string, e: AiLogEntry) { this.aiLog.set(t, [...(this.aiLog.get(t) ?? []), e]); }
  async listAiLog(t: string, limit: number) { return (this.aiLog.get(t) ?? []).slice(-limit).reverse(); }
  private k = (t: string, id: string) => `${t}\u0000${id}`;

  /** Transactions run one at a time, like Postgres row locks (`FOR UPDATE`) make two writers on one case take turns. */
  private chain: Promise<unknown> = Promise.resolve();
  async tx<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tenantId = tenantOf(scope);
    const run = this.chain.then(() => this.txNow(tenantId, fn));
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async txNow<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
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
