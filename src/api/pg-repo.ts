import pg from 'pg';
import { appendEvent, staffSummary, verifyChain } from '../engine';
import type { AuditEvent, AuditEventInput, CaseState, Report, StaffReportSummary } from '../engine';
import { LegalLibrary } from '../legal';
import type { Instrument, InstrumentVersion, RuleBinding } from '../legal';
import type { Proposal } from '../legal';
import { tenantOf } from './repo';
import type { AiLogEntry, CaseDocument, Notification, Person, ReportChannel, ReportTx, Repo, Scope, Tx } from './repo';
import type { AiSettings } from '../ai/consent';
import { defaultSettings } from '../ai/consent';

const LEGAL_LOCK = 7001;

import type { TenantKey } from '../security/crypto';

export class PgRepo implements Repo {
  private constructor(private pool: pg.Pool) {}

  /** Refuses to run as a role that bypasses row-level security: that would silently disable tenant isolation. */
  static async connect(connectionString: string): Promise<PgRepo> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    const r = await pool.query('SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user');
    if (r.rows[0]?.bypass) {
      await pool.end();
      throw new Error('Refusing to start: the database role bypasses row-level security. Connect as cms_app.');
    }
    return new PgRepo(pool);
  }

  async close() { await this.pool.end(); }

  private async run<T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const tenantId = tenantOf(scope);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const rank = { STANDARD: 0, RESTRICTED: 1, PRIVILEGED: 2 };
      const a = typeof scope === 'string' ? undefined : scope;
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', $2, true), set_config('app.kind', $3, true),
        set_config('app.departments', $4, true), set_config('app.roles', $5, true), set_config('app.matters', $6, true), set_config('app.clearance', $7, true)`,
        [tenantId, a ? 'actor' : 'full', a?.kind ?? '', (a?.departments ?? []).join(','), (a?.roles ?? []).join(','), (a?.counselMatterIds ?? []).join(','), String(a ? rank[a.clearance] : 2)]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  tx<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tenantId = tenantOf(scope);
    return this.run(scope, (c) => {
      const loadAudit = async (caseId: string): Promise<AuditEvent[]> =>
        (await c.query('SELECT * FROM audit_events WHERE tenant_id = $1 AND case_id = $2 ORDER BY seq', [tenantId, caseId])).rows.map((r) => ({
          caseId: r.case_id, tenantId: r.tenant_id, seq: Number(r.seq), type: r.type, actorId: r.actor_id, actorKind: r.actor_kind,
          at: r.at, payload: r.payload, prevHash: r.prev_hash.trim(), hash: r.hash.trim(),
        }));
      return fn({
        async getCase(id, lock) {
          const r = await c.query(`SELECT data FROM cases WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
          return r.rows[0]?.data as CaseState | undefined;
        },
        async listCases() {
          return (await c.query('SELECT data FROM cases WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows.map((r) => r.data as CaseState);
        },
        async saveCase(cs: CaseState, ev: AuditEventInput, create?: boolean) {
          const args = [cs.tenantId, cs.id, cs.caseTypeKey, cs.caseTypeVersion, cs.department, cs.state, cs.confidentiality, JSON.stringify(cs), ev.at];
          if (create) {
            await c.query("INSERT INTO tenant_registry (tenant_id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [cs.tenantId, ev.at]);
            await c.query('INSERT INTO cases (tenant_id,id,case_type_key,case_type_version,department,state,confidentiality,data,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', args);
          } else {
            const u = await c.query('UPDATE cases SET case_type_key=$3, case_type_version=$4, department=$5, state=$6, confidentiality=$7, data=$8, updated_at=$9 WHERE tenant_id=$1 AND id=$2', args);
            if (u.rowCount !== 1) throw new Error('CASE_NOT_FOUND');
          }
          const e = appendEvent(await loadAudit(cs.id), ev).at(-1)!;
          await c.query('INSERT INTO audit_events (tenant_id,case_id,seq,type,actor_id,actor_kind,at,payload,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [e.tenantId, e.caseId, e.seq, e.type, e.actorId, e.actorKind, e.at, JSON.stringify(e.payload), e.prevHash, e.hash]);
        },
        getAudit: loadAudit,
      });
    });
  }

  lib<T>(tenantId: string, mode: 'read' | 'write', fn: (lib: LegalLibrary) => Promise<T> | T): Promise<T> {
    return this.run(tenantId, async (c) => {
      if (mode === 'write') await c.query('SELECT pg_advisory_xact_lock($1)', [LEGAL_LOCK]);
      const lib = new LegalLibrary();
      const seen = new Map<string, string>();
      const load = async <X>(table: string, into: Map<string, X>) => {
        for (const r of (await c.query(`SELECT id, data FROM ${table}`)).rows) { into.set(r.id, r.data as X); seen.set(`${table}:${r.id}`, JSON.stringify(r.data)); }
      };
      // Row-level security decides which rows come back; clients never receive baseline drafts or AI proposals.
      await load<Instrument>('legal_instruments', lib.instruments);
      await load<InstrumentVersion>('legal_versions', lib.versions);
      await load<RuleBinding>('legal_bindings', lib.bindings);
      await load<Proposal>('legal_proposals', lib.proposals);
      const logged = lib.log.length;
      const out = await fn(lib);
      if (mode === 'write') {
        const scope = tenantId === 'platform' ? null : tenantId;
        const instScope = (id: string) => lib.instruments.get(id)?.tenantId ?? null;
        const put = async (table: string, id: string, data: unknown, sql: string, args: unknown[]) => {
          const j = JSON.stringify(data);
          if (seen.get(`${table}:${id}`) === j) return;
          await c.query(sql, args);
        };
        for (const i of lib.instruments.values()) {
          await put('legal_instruments', i.id, i, 'INSERT INTO legal_instruments (id,scope_tenant_id,data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [i.id, i.tenantId, JSON.stringify(i)]);
        }
        for (const v of lib.versions.values()) {
          await put('legal_versions', v.id, v, 'INSERT INTO legal_versions (id,scope_tenant_id,instrument_id,status,data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [v.id, instScope(v.instrumentId), v.instrumentId, v.status, JSON.stringify(v)]);
        }
        for (const b of lib.bindings.values()) {
          await put('legal_bindings', b.id, b, 'INSERT INTO legal_bindings (id,scope_tenant_id,data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [b.id, instScope(b.instrumentId), JSON.stringify(b)]);
        }
        for (const p of lib.proposals.values()) {
          await put('legal_proposals', p.id, p, 'INSERT INTO legal_proposals (id,scope_tenant_id,version_id,data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [p.id, p.scopeTenantId, p.versionId, JSON.stringify(p)]);
        }
        for (const l of lib.log.slice(logged)) {
          await c.query('INSERT INTO legal_log (scope_tenant_id,at,actor_id,type,ref) VALUES ($1,$2,$3,$4,$5)', [scope, l.at, l.actorId, l.type, l.ref]);
        }
      }
      return out;
    });
  }

  putFile(tenantId: string, f: { sha256: string; name: string; bytes: Uint8Array; uploadedBy: string }) {
    return this.run(tenantId, async (c) => {
      await c.query('INSERT INTO legal_files (sha256,scope_tenant_id,name,bytes,uploaded_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha256) DO NOTHING',
        [f.sha256, tenantId === 'platform' ? null : tenantId, f.name, Buffer.from(f.bytes), f.uploadedBy]);
    });
  }

  putCaseDocument(scope: Scope, caseId: string, d: CaseDocument) {
    const tenantId = tenantOf(scope);
    return this.run(scope, async (c) => {
      await c.query('INSERT INTO case_documents (tenant_id,case_id,sha256,name,mime,size_bytes,bytes,uploaded_by,uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, case_id, sha256) DO NOTHING',
        [tenantId, caseId, d.sha256, d.name, d.mime, d.bytes.byteLength, Buffer.from(d.bytes), d.uploadedBy, d.uploadedAt]);
    });
  }
  getCaseDocument(scope: Scope, caseId: string, sha256: string) {
    const tenantId = tenantOf(scope);
    return this.run(scope, async (c) => {
      const r = (await c.query('SELECT sha256, name, mime, bytes, uploaded_by, uploaded_at FROM case_documents WHERE tenant_id = $1 AND case_id = $2 AND sha256 = $3', [tenantId, caseId, sha256])).rows[0];
      return r ? { sha256: String(r.sha256).trim(), name: r.name, mime: r.mime, bytes: new Uint8Array(r.bytes), uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at } as CaseDocument : undefined;
    });
  }

  touchPerson(p: Person) {
    return this.run(p.tenantId, async (c) => { await c.query(`INSERT INTO tenant_people (tenant_id,id,name,kind,departments,roles,reports_to,last_seen,clearance,email,matters) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, departments=EXCLUDED.departments, roles=EXCLUDED.roles, reports_to=EXCLUDED.reports_to, last_seen=EXCLUDED.last_seen, clearance=EXCLUDED.clearance, email=EXCLUDED.email, matters=EXCLUDED.matters`,
      [p.tenantId, p.id, p.name, p.kind, p.departments.join(','), p.roles.join(','), p.reportsTo.join(','), p.lastSeen, p.clearance ?? 'STANDARD', p.email ?? null, (p.counselMatterIds ?? []).join(',')]); });
  }
  private toPerson = (r: any): Person => {
    const split = (s: string) => (s ? s.split(',') : []);
    return { id: r.id, name: r.name, kind: r.kind, tenantId: r.tenant_id, departments: split(r.departments), roles: split(r.roles), reportsTo: split(r.reports_to), lastSeen: r.last_seen,
      clearance: r.clearance, email: r.email, emailOptout: r.email_optout, counselMatterIds: split(r.matters) };
  };
  listPeople(tenantId: string) {
    return this.run(tenantId, async (c) => (await c.query('SELECT * FROM tenant_people WHERE tenant_id=$1 ORDER BY name', [tenantId])).rows.map(this.toPerson));
  }
  setEmailOptout(tenantId: string, userId: string, optout: boolean) {
    return this.run(tenantId, async (c) => { await c.query('UPDATE tenant_people SET email_optout=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, userId, optout]); });
  }
  private toNote = (r: any): Notification => ({ id: r.id, tenantId: r.tenant_id, userId: r.user_id, kind: r.kind, caseId: r.case_id, actorId: r.actor_id, dedupeKey: r.dedupe_key, createdAt: r.created_at, readAt: r.read_at, emailedAt: r.emailed_at });
  addNotification(n: Notification) {
    return this.run(n.tenantId, async (c) => (await c.query('INSERT INTO notifications (tenant_id,id,user_id,kind,case_id,actor_id,dedupe_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
      [n.tenantId, n.id, n.userId, n.kind, n.caseId, n.actorId ?? null, n.dedupeKey ?? null, n.createdAt])).rowCount === 1);
  }
  listNotifications(t: string, u: string, o: { unreadOnly?: boolean; limit?: number }) {
    return this.run(t, async (c) => (await c.query(`SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 ${o.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $3`, [t, u, o.limit ?? 50])).rows.map(this.toNote));
  }
  countUnread(t: string, u: string) {
    return this.run(t, async (c) => Number((await c.query('SELECT count(*) n FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL', [t, u])).rows[0].n));
  }
  markRead(t: string, u: string, ids: string[] | 'all', at: string) {
    return this.run(t, async (c) => { await c.query(`UPDATE notifications SET read_at=$3 WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL ${ids === 'all' ? '' : 'AND id = ANY($4)'}`, ids === 'all' ? [t, u, at] : [t, u, at, ids]); });
  }
  pendingEmails(t: string, limit: number) {
    return this.run(t, async (c) => (await c.query(`SELECT n.id n_id, n.user_id, n.kind, n.case_id, n.actor_id, n.dedupe_key, n.created_at n_created, n.read_at, n.emailed_at, p.*
      FROM notifications n JOIN tenant_people p ON p.tenant_id=n.tenant_id AND p.id=n.user_id WHERE n.tenant_id=$1 AND n.emailed_at IS NULL ORDER BY n.created_at LIMIT $2`, [t, limit])).rows
      .map((r) => ({ n: { id: r.n_id, tenantId: t, userId: r.user_id, kind: r.kind, caseId: r.case_id, actorId: r.actor_id, dedupeKey: r.dedupe_key, createdAt: r.n_created, readAt: r.read_at, emailedAt: r.emailed_at } as Notification, person: this.toPerson(r) })));
  }
  markEmailed(t: string, ids: string[], at: string) {
    return this.run(t, async (c) => { await c.query('UPDATE notifications SET emailed_at=$3 WHERE tenant_id=$1 AND id = ANY($2)', [t, ids, at]); });
  }

  async listTenants() { return (await this.pool.query('SELECT tenant_id FROM tenant_registry ORDER BY 1')).rows.map((r) => r.tenant_id as string); }
  async withLock(name: string, fn: () => Promise<void>) {
    const c = await this.pool.connect();
    try {
      if (!(await c.query('SELECT pg_try_advisory_lock(hashtext($1)) ok', [name])).rows[0].ok) return false;
      try { await fn(); } finally { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); }
      return true;
    } finally { c.release(); }
  }

  async loadRevocations() {
    const r = await this.pool.query('SELECT subject, not_before FROM session_revocations');
    return Object.fromEntries(r.rows.map((x) => [x.subject as string, Number(x.not_before)]));
  }
  async setRevocation(subject: string, notBefore: number) {
    await this.pool.query('INSERT INTO session_revocations (subject, not_before, created_at) VALUES ($1,$2,$3) ON CONFLICT (subject) DO UPDATE SET not_before = GREATEST(session_revocations.not_before, EXCLUDED.not_before)', [subject, notBefore, new Date().toISOString()]);
  }

  getTenantKeys(tenantId: string) {
    return this.run(tenantId, async (c) => (await c.query('SELECT version, master_key_id, wrapped, created_at FROM tenant_keys WHERE tenant_id = $1 ORDER BY version', [tenantId])).rows
      .map((r) => ({ version: Number(r.version), masterKeyId: r.master_key_id, wrapped: r.wrapped, createdAt: r.created_at }) as TenantKey));
  }
  putTenantKey(tenantId: string, k: TenantKey) {
    return this.run(tenantId, async (c) => (await c.query('INSERT INTO tenant_keys (tenant_id, version, master_key_id, wrapped, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [tenantId, k.version, k.masterKeyId, k.wrapped, k.createdAt])).rowCount === 1);
  }

  getAiSettings(tenantId: string) {
    return this.run(tenantId, async (c) => {
      const r = await c.query('SELECT data FROM tenant_ai_settings WHERE tenant_id = $1', [tenantId]);
      return (r.rows[0]?.data as AiSettings | undefined) ?? defaultSettings(tenantId);
    });
  }
  saveAiSettings(tenantId: string, s: AiSettings, e: AiLogEntry) {
    return this.run(tenantId, async (c) => {
      await c.query('INSERT INTO tenant_ai_settings (tenant_id, mode, data) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode, data = EXCLUDED.data', [tenantId, s.mode, JSON.stringify(s)]);
      await c.query('INSERT INTO ai_log (tenant_id, at, actor_id, type, data) VALUES ($1,$2,$3,$4,$5)', [tenantId, e.at, e.actorId, e.type, JSON.stringify(e.data)]);
    });
  }
  logAi(tenantId: string, e: AiLogEntry) {
    return this.run(tenantId, async (c) => { await c.query('INSERT INTO ai_log (tenant_id, at, actor_id, type, data) VALUES ($1,$2,$3,$4,$5)', [tenantId, e.at, e.actorId, e.type, JSON.stringify(e.data)]); });
  }
  listAiLog(tenantId: string, limit: number) {
    return this.run(tenantId, async (c) =>
      (await c.query('SELECT at, actor_id, type, data FROM ai_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2', [tenantId, limit])).rows.map((r) => ({ at: r.at, actorId: r.actor_id, type: r.type, data: r.data })));
  }

  // ---- Report & Track -------------------------------------------------------
  /**
   * The unauthenticated lookup: no tenant, only the token the caller presented. The row-level policy lets exactly the row
   * with that token be read and nothing else, so even a bug here cannot list channels or reveal other tenants.
   */
  private async runChannelLookup<T>(token: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', '', true), set_config('app.channel_token', $1, true)", [token]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  private channelRow = (r: any): ReportChannel => ({ id: r.id, tenantId: r.tenant_id, token: r.token, label: r.label, active: r.active, createdAt: r.created_at, createdBy: r.created_by });

  channelByToken(token: string) {
    return this.runChannelLookup(token, async (c) => {
      const r = await c.query('SELECT * FROM report_channels WHERE token = $1', [token]);
      return r.rows[0] ? this.channelRow(r.rows[0]) : undefined;
    });
  }
  listChannels(tenantId: string) {
    return this.run(tenantId, async (c) => (await c.query('SELECT * FROM report_channels WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows.map(this.channelRow));
  }
  saveChannel(ch: ReportChannel) {
    return this.run(ch.tenantId, async (c) => {
      await c.query('INSERT INTO tenant_registry (tenant_id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ch.tenantId, ch.createdAt]);
      await c.query(
        'INSERT INTO report_channels (tenant_id,id,token,label,active,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, id) DO UPDATE SET label = EXCLUDED.label, active = EXCLUDED.active',
        [ch.tenantId, ch.id, ch.token, JSON.stringify(ch.label), ch.active, ch.createdAt, ch.createdBy]);
    });
  }

  reportTx<T>(tenantId: string, fn: (tx: ReportTx) => Promise<T>): Promise<T> {
    return this.run(tenantId, (c) => fn({
      async get(id, lock) {
        const r = await c.query(`SELECT data FROM reports WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
        return r.rows[0]?.data as Report | undefined;
      },
      async getByCodeHash(codeHash) {
        const r = await c.query('SELECT data FROM reports WHERE tenant_id = $1 AND code_hash = $2 FOR UPDATE', [tenantId, codeHash]);
        return r.rows[0]?.data as Report | undefined;
      },
      async list(filter) {
        const r = await c.query(
          `SELECT id,status,category,language,channel_id,created_at,updated_at,message_count,awaiting_staff,case_id FROM reports WHERE tenant_id = $1${filter?.status ? ' AND status = $2' : ''} ORDER BY updated_at DESC LIMIT 1000`,
          filter?.status ? [tenantId, filter.status] : [tenantId]);
        return r.rows.map((x): StaffReportSummary => ({
          id: x.id, status: x.status, category: x.category, language: x.language, channelId: x.channel_id, createdAt: x.created_at, updatedAt: x.updated_at,
          messageCount: x.message_count, awaitingStaff: x.awaiting_staff, ...(x.case_id ? { caseId: x.case_id } : {}),
        }));
      },
      async save(rep, create) {
        if (rep.tenantId !== tenantId) throw new Error('TENANT_MISMATCH');
        const s = staffSummary(rep);
        if (create) {
          await c.query('INSERT INTO reports (tenant_id,id,channel_id,code_hash,status,category,language,message_count,awaiting_staff,case_id,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
            [tenantId, rep.id, rep.channelId, rep.codeHash, rep.status, rep.category, rep.language, s.messageCount, s.awaitingStaff, rep.caseId ?? null, rep.createdAt, rep.updatedAt, JSON.stringify(rep)]);
        } else {
          // Identity (channel, code hash, created_at) never changes: it is not in the SET list, and it is part of the match,
          // so a save carrying a different identity updates nothing instead of leaving the JSON and the columns disagreeing.
          const u = await c.query('UPDATE reports SET status=$3, category=$4, language=$5, message_count=$6, awaiting_staff=$7, case_id=$8, updated_at=$9, data=$10 WHERE tenant_id=$1 AND id=$2 AND code_hash=$11 AND channel_id=$12 AND created_at=$13',
            [tenantId, rep.id, rep.status, rep.category, rep.language, s.messageCount, s.awaitingStaff, rep.caseId ?? null, rep.updatedAt, JSON.stringify(rep), rep.codeHash, rep.channelId, rep.createdAt]);
          if (u.rowCount !== 1) throw new Error('REPORT_NOT_FOUND_OR_IDENTITY_CHANGED');
        }
      },
    }));
  }

  verifyChain(e: AuditEvent[]) { return verifyChain(e); }
}
