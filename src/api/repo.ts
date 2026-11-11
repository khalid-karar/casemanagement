import { appendEvent, staffSummary, verifyChain } from '../engine';
import type { Actor, AuditEvent, AuditEventInput, CaseState, Report, StaffReportSummary } from '../engine';
import { LegalLibrary } from '../legal';
import type { RevocationStore } from './revocation';
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

/**
 * A QR code on a poster at a site. The token in its URL is the only thing an unauthenticated reporter presents, and it
 * does one job: say which organisation (and which place) this report is for. It is not a secret — it is printed in
 * public — so it is stored in clear, which lets an administrator reprint the poster.
 */
export interface ReportChannel {
  id: string; tenantId: string; token: string; label: { ar: string; en: string }; active: boolean; createdAt: string; createdBy: string;
}
export const CHANNEL_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** One tenant-scoped transaction over reports. It deliberately exposes nothing about cases, so the public routes cannot reach them. */
export interface ReportTx {
  get(id: string, lock?: boolean): Promise<Report | undefined>;
  /** For the reporter: finds their report from the hash of the code they presented. Locks the row. */
  getByCodeHash(codeHash: string): Promise<Report | undefined>;
  /** Inbox rows. Reads columns only: no message is read or decrypted to draw a list. */
  list(filter?: { status?: Report['status'] }): Promise<StaffReportSummary[]>;
  /** create=true inserts (fails if the id or code already exists); otherwise updates. */
  save(r: Report, create?: boolean): Promise<void>;
}
export interface ReportStore {
  reportTx<T>(tenantId: string, fn: (tx: ReportTx) => Promise<T>): Promise<T>;
  /** The one lookup that needs no tenant. Returns undefined for an unknown token; never lists. */
  channelByToken(token: string): Promise<ReportChannel | undefined>;
  listChannels(tenantId: string): Promise<ReportChannel[]>;
  saveChannel(c: ReportChannel): Promise<void>;
}

export interface Person {
  id: string; name: string; kind: string; tenantId: string; departments: string[]; roles: string[]; reportsTo: string[]; lastSeen: string;
  clearance?: 'STANDARD' | 'RESTRICTED' | 'PRIVILEGED'; email?: string | null; emailOptout?: boolean; counselMatterIds?: string[];
}

export type NotificationKind = 'ASSIGNED' | 'MENTIONED' | 'STATE_CHANGED' | 'SLA_RISK' | 'SLA_BREACH' | 'ACTION_DUE' | 'REPORT_NEW' | 'REPORT_REPLY' | 'REPORT_STALE';
/** Says that something happened on a case, never what is inside it. */
export interface Notification {
  id: string; tenantId: string; userId: string; kind: NotificationKind; caseId: string; actorId?: string | null;
  dedupeKey?: string | null; createdAt: string; readAt?: string | null; emailedAt?: string | null;
}

export interface Repo extends KeyStore, RevocationStore, ReportStore {
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
  touchPerson(p: Person): Promise<void>;
  setEmailOptout(tenantId: string, userId: string, optout: boolean): Promise<void>;
  /** Adds a notification; a repeated dedupeKey for the same person is ignored. Returns whether it was new. */
  addNotification(n: Notification): Promise<boolean>;
  listNotifications(tenantId: string, userId: string, opts: { unreadOnly?: boolean; limit?: number }): Promise<Notification[]>;
  countUnread(tenantId: string, userId: string): Promise<number>;
  markRead(tenantId: string, userId: string, ids: string[] | 'all', at: string): Promise<void>;
  pendingEmails(tenantId: string, limit: number): Promise<{ n: Notification; person: Person }[]>;
  markEmailed(tenantId: string, ids: string[], at: string): Promise<void>;
  listPeople(tenantId: string): Promise<Person[]>;
  /** Every tenant that has data (for background jobs). */
  listTenants(): Promise<string[]>;
  /** Runs fn only if no other server holds the named lock (so a scheduled job runs on one server at a time). Returns false when skipped. */
  withLock(name: string, fn: () => Promise<void>): Promise<boolean>;
  close?(): Promise<void>;
}

/** In-memory repo for tests and local demos. */
export class MemoryRepo implements Repo {
  private cases = new Map<string, CaseState>();
  private audit = new Map<string, AuditEvent[]>();
  private library = new LegalLibrary();
  files = new Map<string, { name: string; bytes: Uint8Array; uploadedBy: string }>();
  private docs = new Map<string, CaseDocument>();
  private revoked: Record<string, number> = {};
  async loadRevocations() { return { ...this.revoked }; }
  async setRevocation(s: string, nb: number) { this.revoked[s] = Math.max(nb, this.revoked[s] ?? 0); }
  private people = new Map<string, Person>();
  private notes: Notification[] = [];
  async setEmailOptout(t: string, u: string, o: boolean) { const p = this.people.get(`${t}|${u}`); if (p) p.emailOptout = o; }
  async addNotification(n: Notification) {
    if (n.dedupeKey && this.notes.some((x) => x.tenantId === n.tenantId && x.userId === n.userId && x.dedupeKey === n.dedupeKey)) return false;
    this.notes.push({ ...n }); return true;
  }
  async listNotifications(t: string, u: string, o: { unreadOnly?: boolean; limit?: number }) {
    return this.notes.filter((n) => n.tenantId === t && n.userId === u && (!o.unreadOnly || !n.readAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, o.limit ?? 50);
  }
  async countUnread(t: string, u: string) { return this.notes.filter((n) => n.tenantId === t && n.userId === u && !n.readAt).length; }
  async markRead(t: string, u: string, ids: string[] | 'all', at: string) { for (const n of this.notes) if (n.tenantId === t && n.userId === u && !n.readAt && (ids === 'all' || ids.includes(n.id))) n.readAt = at; }
  async pendingEmails(t: string, limit: number) {
    return this.notes.filter((n) => n.tenantId === t && !n.emailedAt).slice(0, limit).flatMap((n) => { const p = this.people.get(`${t}|${n.userId}`); return p ? [{ n, person: p }] : []; });
  }
  async markEmailed(t: string, ids: string[], at: string) { for (const n of this.notes) if (n.tenantId === t && ids.includes(n.id)) n.emailedAt = at; }
  async touchPerson(p: Person) { const k = `${p.tenantId}|${p.id}`; this.people.set(k, { ...p, emailOptout: this.people.get(k)?.emailOptout ?? false }); }
  async listPeople(t: string) { return [...this.people.values()].filter((p) => p.tenantId === t).sort((a, b) => a.name.localeCompare(b.name)); }
  private locks = new Set<string>();
  async listTenants() {
    // Tenants that have only set up a reporting channel and received nothing yet still need their stale-report sweep.
    return [...new Set([...[...this.cases.values()].map((c) => c.tenantId), ...[...this.channels.values()].map((c) => c.tenantId)])].sort();
  }
  async withLock(name: string, fn: () => Promise<void>) { if (this.locks.has(name)) return false; this.locks.add(name); try { await fn(); return true; } finally { this.locks.delete(name); } }
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

  // ---- Report & Track ----
  private reports = new Map<string, Report>();
  private channels = new Map<string, ReportChannel>(); // by token
  private rchain: Promise<unknown> = Promise.resolve();
  async reportTx<T>(tenantId: string, fn: (tx: ReportTx) => Promise<T>): Promise<T> {
    const self = this;
    const run = this.rchain.then(() => fn({
      async get(id) { return self.reports.get(self.k(tenantId, id)); },
      async getByCodeHash(h) { return [...self.reports.values()].find((r) => r.tenantId === tenantId && r.codeHash === h); },
      async list(f) {
        return [...self.reports.values()].filter((r) => r.tenantId === tenantId && (!f?.status || r.status === f.status))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(staffSummary);
      },
      async save(r, create) {
        if (r.tenantId !== tenantId) throw new Error('TENANT_MISMATCH');
        const key = self.k(tenantId, r.id);
        if (create && (self.reports.has(key) || [...self.reports.values()].some((x) => x.tenantId === tenantId && x.codeHash === r.codeHash))) throw new Error('REPORT_EXISTS');
        // The database trigger's rule, kept here so tests on the memory repo cannot pass where Postgres would refuse.
        const old = self.reports.get(key);
        if (!create && !old) throw new Error('REPORT_NOT_FOUND');
        if (old) {
          if (old.codeHash !== r.codeHash || old.createdAt !== r.createdAt || old.channelId !== r.channelId) throw new Error('report identity is immutable');
          if (r.events.length < old.events.length || old.events.some((e, i) => JSON.stringify(e) !== JSON.stringify(r.events[i]))) throw new Error('report history is append-only');
        }
        self.reports.set(key, r);
      },
    }));
    this.rchain = run.catch(() => undefined);
    return run;
  }
  async channelByToken(token: string) { const c = this.channels.get(token); return c && { ...c }; }
  async listChannels(t: string) { return [...this.channels.values()].filter((c) => c.tenantId === t).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => ({ ...c })); }
  async saveChannel(c: ReportChannel) {
    const existing = this.channels.get(c.token);
    if (existing && (existing.tenantId !== c.tenantId || existing.id !== c.id)) throw new Error('CHANNEL_TOKEN_EXISTS');
    this.channels.set(c.token, { ...c });
  }

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
