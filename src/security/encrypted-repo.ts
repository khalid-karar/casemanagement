import type { Amendment, Artifact, AuditEvent, CaseState, CorrectiveAction, Report } from '../engine';
import { tenantOf } from '../api/repo';
import type { CaseDocument, ReportTx, Repo, Scope, Tx } from '../api/repo';
import { CASE_TYPES } from '../case-types';
import { DataCrypto, type TenantKey } from './crypto';

/**
 * Wraps any Repo so that what is sensitive is encrypted before it reaches storage and decrypted on the way out:
 *   - case fields marked PERSONAL or SEALED
 *   - party identities
 *   - artifact payloads (findings, notes, filing contents)
 *   - corrective-action descriptions
 *   - stored document bytes
 * NORMAL fields (titles, dates, enums) stay readable so the database can still filter and sort; the audit log never
 * held sensitive values in the first place (it records hashes for PERSONAL/SEALED changes).
 * Data written before encryption was switched on is still read as-is and is encrypted the next time the case is saved.
 * Any decryption failure throws: the system never falls back to showing partial or wrong data.
 */
const ENC = '__enc';
type Enc = { [ENC]: string };
const isEnc = (x: unknown): x is Enc => typeof x === 'object' && x !== null && typeof (x as Enc)[ENC] === 'string';

export class EncryptedRepo implements Repo {
  constructor(private inner: Repo, private dc: DataCrypto) {}

  private sensitiveKeys(caseTypeKey: string): Set<string> {
    const def = CASE_TYPES[caseTypeKey];
    return new Set((def?.fields ?? []).filter((f) => f.sensitivity !== 'NORMAL').map((f) => f.key));
  }

  async seal(c: CaseState): Promise<CaseState> {
    const t = c.tenantId; const sens = this.sensitiveKeys(c.caseTypeKey);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.fields)) {
      fields[k] = sens.has(k) && v !== undefined && v !== null && !this.dc.isEncrypted(v) ? await this.dc.encryptValue(t, `field|${c.id}|${k}`, v) : v;
    }
    const parties = await Promise.all(c.parties.map(async (p) => ({ ...p, personId: this.dc.isEncrypted(p.personId) ? p.personId : await this.dc.encryptValue(t, `party|${c.id}`, p.personId) })));
    const artifacts = await Promise.all(c.artifacts.map(async (a): Promise<Artifact> => a.payload && !isEnc(a.payload) ? { ...a, payload: { [ENC]: await this.dc.encryptValue(t, `artifact|${c.id}|${a.id}`, a.payload) } } : a));
    const actions = await Promise.all(c.actions.map(async (a): Promise<CorrectiveAction> => this.dc.isEncrypted(a.description) ? a : { ...a, description: await this.dc.encryptValue(t, `action|${c.id}|${a.id}`, a.description) }));
    // A correction to a PERSONAL or SEALED field is as sensitive as the field it corrects.
    const amendments = c.amendments && await Promise.all(c.amendments.map(async (a): Promise<Amendment> => {
      if (!sens.has(a.field)) return a;
      const enc = async (v: unknown, part: string) => v === undefined || v === null || this.dc.isEncrypted(v) ? v : this.dc.encryptValue(t, `amendment|${c.id}|${a.id}|${part}`, v);
      return { ...a, originalValue: await enc(a.originalValue, 'original'), correctedValue: await enc(a.correctedValue, 'corrected') };
    }));
    return { ...c, fields, parties, artifacts, actions, ...(amendments ? { amendments } : {}) };
  }

  async open(c: CaseState): Promise<CaseState> {
    const t = c.tenantId;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.fields)) fields[k] = this.dc.isEncrypted(v) ? await this.dc.decryptValue(t, `field|${c.id}|${k}`, v) : v;
    const parties = await Promise.all(c.parties.map(async (p) => ({ ...p, personId: this.dc.isEncrypted(p.personId) ? String(await this.dc.decryptValue(t, `party|${c.id}`, p.personId)) : p.personId })));
    const artifacts = await Promise.all(c.artifacts.map(async (a): Promise<Artifact> => isEnc(a.payload) ? { ...a, payload: (await this.dc.decryptValue(t, `artifact|${c.id}|${a.id}`, a.payload[ENC])) as Record<string, unknown> } : a));
    const actions = await Promise.all(c.actions.map(async (a): Promise<CorrectiveAction> => this.dc.isEncrypted(a.description) ? { ...a, description: String(await this.dc.decryptValue(t, `action|${c.id}|${a.id}`, a.description)) } : a));
    const amendments = c.amendments && await Promise.all(c.amendments.map(async (a): Promise<Amendment> => {
      const dec = async (v: unknown, part: string) => this.dc.isEncrypted(v) ? this.dc.decryptValue(t, `amendment|${c.id}|${a.id}|${part}`, v) : v;
      return { ...a, originalValue: await dec(a.originalValue, 'original'), correctedValue: await dec(a.correctedValue, 'corrected') };
    }));
    return { ...c, fields, parties, artifacts, actions, ...(amendments ? { amendments } : {}) };
  }

  tx<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.inner.tx(scope, (tx) => fn({
      getCase: async (id, lock) => { const c = await tx.getCase(id, lock); return c ? this.open(c) : undefined; },
      listCases: async () => Promise.all((await tx.listCases()).map((c) => this.open(c))),
      saveCase: async (c, ev, create) => tx.saveCase(await this.seal(c), ev, create),
      getAudit: (id): Promise<AuditEvent[]> => tx.getAudit(id),
    }));
  }

  async putCaseDocument(sc: Scope, caseId: string, d: CaseDocument) {
    const t = tenantOf(sc);
    return this.inner.putCaseDocument(sc, caseId, { ...d, bytes: await this.dc.encryptBytes(t, `doc|${caseId}|${d.sha256}`, d.bytes) });
  }
  async getCaseDocument(sc: Scope, caseId: string, sha256: string) {
    const t = tenantOf(sc);
    const d = await this.inner.getCaseDocument(sc, caseId, sha256);
    return d ? { ...d, bytes: await this.dc.decryptBytes(t, `doc|${caseId}|${d.sha256}`, d.bytes) } : undefined;
  }

  /**
   * Reports. Every message text and the closing note are encrypted on every save, unconditionally and with an explicit
   * `sealed` marker, never by sniffing the text for a ciphertext prefix: the text is written by an anonymous stranger,
   * and a report that merely began with the prefix would otherwise be stored in clear and then fail to open. The history
   * and the inbox columns hold digests and counts only, so they stay readable. Each ciphertext is bound to its report
   * and message number, so swapping two messages' ciphertext fails to decrypt instead of showing the wrong words.
   */
  async sealReport(r: Report): Promise<Report> {
    const t = r.tenantId;
    const messages = await Promise.all(r.messages.map(async (m) => ({ ...m, text: await this.dc.encryptValue(t, `report|${r.id}|msg|${m.n}`, m.text) })));
    const { closingNote, ...rest } = r;
    return { ...rest, messages, ...(closingNote !== undefined ? { closingNote: await this.dc.encryptValue(t, `report|${r.id}|note`, closingNote) } : {}), sealed: true };
  }
  async openReport(r: Report): Promise<Report> {
    if (!r.sealed) return r; // stored before encryption was switched on
    const t = r.tenantId;
    const messages = await Promise.all(r.messages.map(async (m) => ({ ...m, text: String(await this.dc.decryptValue(t, `report|${r.id}|msg|${m.n}`, m.text)) })));
    const { closingNote, sealed: _sealed, ...rest } = r;
    return { ...rest, messages, ...(closingNote !== undefined ? { closingNote: String(await this.dc.decryptValue(t, `report|${r.id}|note`, closingNote)) } : {}) };
  }
  reportTx: Repo['reportTx'] = (tenantId, fn) => this.inner.reportTx(tenantId, (tx) => fn({
    get: async (id, lock) => { const r = await tx.get(id, lock); return r ? this.openReport(r) : undefined; },
    getByCodeHash: async (h) => { const r = await tx.getByCodeHash(h); return r ? this.openReport(r) : undefined; },
    list: (f) => tx.list(f),
    save: async (r, create) => tx.save(await this.sealReport(r), create),
  } satisfies ReportTx));
  // Channels hold a label and a public token, nothing sensitive.
  channelByToken: Repo['channelByToken'] = (t) => this.inner.channelByToken(t);
  listChannels: Repo['listChannels'] = (t) => this.inner.listChannels(t);
  saveChannel: Repo['saveChannel'] = (c) => this.inner.saveChannel(c);

  lib: Repo['lib'] = (t, m, fn) => this.inner.lib(t, m, fn);
  putFile: Repo['putFile'] = (t, f) => this.inner.putFile(t, f);
  getAiSettings: Repo['getAiSettings'] = (t) => this.inner.getAiSettings(t);
  saveAiSettings: Repo['saveAiSettings'] = (t, s, e) => this.inner.saveAiSettings(t, s, e);
  logAi: Repo['logAi'] = (t, e) => this.inner.logAi(t, e);
  listAiLog: Repo['listAiLog'] = (t, n) => this.inner.listAiLog(t, n);
  verifyChain: Repo['verifyChain'] = (e) => this.inner.verifyChain(e);
  getTenantKeys = (t: string): Promise<TenantKey[]> => this.inner.getTenantKeys(t);
  putTenantKey = (t: string, k: TenantKey) => this.inner.putTenantKey(t, k);
  loadRevocations: Repo['loadRevocations'] = () => this.inner.loadRevocations();
  setRevocation: Repo['setRevocation'] = (s, n) => this.inner.setRevocation(s, n);
  touchPerson: Repo['touchPerson'] = (p) => this.inner.touchPerson(p);
  listPeople: Repo['listPeople'] = (t) => this.inner.listPeople(t);
  setEmailOptout: Repo['setEmailOptout'] = (t, u, o) => this.inner.setEmailOptout(t, u, o);
  addNotification: Repo['addNotification'] = (n) => this.inner.addNotification(n);
  listNotifications: Repo['listNotifications'] = (t, u, o) => this.inner.listNotifications(t, u, o);
  countUnread: Repo['countUnread'] = (t, u) => this.inner.countUnread(t, u);
  markRead: Repo['markRead'] = (t, u, i, a) => this.inner.markRead(t, u, i, a);
  pendingEmails: Repo['pendingEmails'] = (t, l) => this.inner.pendingEmails(t, l);
  markEmailed: Repo['markEmailed'] = (t, i, a) => this.inner.markEmailed(t, i, a);
  listTenants: Repo['listTenants'] = () => this.inner.listTenants();
  withLock: Repo['withLock'] = (n, f) => this.inner.withLock(n, f);
  close = () => this.inner.close?.() ?? Promise.resolve();
}
