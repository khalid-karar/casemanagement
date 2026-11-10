import pg from 'pg';
import { appendEvent, verifyChain } from '../engine';
import type { AuditEvent, AuditEventInput, CaseState } from '../engine';
import { LegalLibrary } from '../legal';
import type { Instrument, InstrumentVersion, RuleBinding } from '../legal';
import type { Proposal } from '../legal';
import { tenantOf } from './repo';
import type { AiLogEntry, CaseDocument, Repo, Scope, Tx } from './repo';
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

  verifyChain(e: AuditEvent[]) { return verifyChain(e); }
}
