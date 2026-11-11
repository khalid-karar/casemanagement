import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Application-level envelope encryption (AES-256-GCM).
 *
 *   master key(s)  held outside the database (env / mounted secret now; a cloud key vault adapter later, same interface)
 *        │ wraps
 *   data key (DEK) one per tenant and version, stored wrapped in `tenant_keys`
 *        │ encrypts
 *   values         sealed/personal case fields, party identities, stored case documents
 *
 * Every ciphertext is bound to where it lives (tenant, kind, case, field) through GCM's associated data, so a value
 * copied to another field, case or tenant fails to decrypt instead of silently appearing there. Losing the master key
 * means losing the data: back it up separately from the database (docs/ENCRYPTION.md).
 */
export interface TenantKey { version: number; masterKeyId: string; wrapped: string; createdAt: string }
export interface KeyStore {
  getTenantKeys(tenantId: string): Promise<TenantKey[]>;
  /** Returns false when that version already exists (a concurrent writer created it first). */
  putTenantKey(tenantId: string, key: TenantKey): Promise<boolean>;
}

export class CryptoError extends Error {
  constructor(public readonly code: 'NO_MASTER_KEY' | 'UNKNOWN_MASTER_KEY' | 'BAD_CIPHERTEXT' | 'UNKNOWN_KEY_VERSION') { super(code); this.name = 'CryptoError'; }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

function seal(key: Buffer, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key: Buffer, aad: string, blob: Buffer): Buffer {
  if (blob.length < 28) throw new CryptoError('BAD_CIPHERTEXT');
  try {
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  } catch { throw new CryptoError('BAD_CIPHERTEXT'); }
}

export class MasterKeys {
  constructor(public readonly currentId: string, private keys: Record<string, Buffer>) {
    if (!keys[currentId]) throw new CryptoError('UNKNOWN_MASTER_KEY');
    for (const [id, k] of Object.entries(keys)) if (k.length !== 32) throw new Error(`Master key ${id} must be 32 bytes (base64)`);
  }
  get(id: string): Buffer { const k = this.keys[id]; if (!k) throw new CryptoError('UNKNOWN_MASTER_KEY'); return k; }
  ids() { return Object.keys(this.keys); }
  /**
   * DATA_MASTER_KEYS = JSON {"k1":"<base64 32 bytes>",...} (or DATA_MASTER_KEYS_FILE), DATA_MASTER_KEY_ID = the one used for new wraps.
   * Keep old ids while any data key is still wrapped by them; remove them after `rewrap`.
   */
  static fromEnv(env: NodeJS.ProcessEnv): MasterKeys | undefined {
    const raw = env['DATA_MASTER_KEYS_FILE'] ? readFileSync(env['DATA_MASTER_KEYS_FILE'], 'utf8') : env['DATA_MASTER_KEYS'];
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const id = env['DATA_MASTER_KEY_ID'] ?? Object.keys(parsed).at(-1)!;
    return new MasterKeys(id, Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, Buffer.from(v, 'base64')])));
  }
  static generate(id: string) { return { [id]: randomBytes(32).toString('base64') }; }
}

const PREFIX = 'enc:v1:';
const MAGIC = Buffer.from('CMS1');

export class DataCrypto {
  private cache = new Map<string, Promise<Map<number, Buffer>>>();
  constructor(private master: MasterKeys, private store: KeyStore, private now: () => string = () => new Date().toISOString()) {}

  private wrapAad = (tenantId: string, v: number) => `dek|${tenantId}|${v}`;

  private load(tenantId: string): Promise<Map<number, Buffer>> {
    let p = this.cache.get(tenantId);
    if (!p) {
      p = (async () => {
        let rows = await this.store.getTenantKeys(tenantId);
        if (!rows.length) {
          const dek = randomBytes(32);
          const row: TenantKey = { version: 1, masterKeyId: this.master.currentId, wrapped: b64(seal(this.master.get(this.master.currentId), this.wrapAad(tenantId, 1), dek)), createdAt: this.now() };
          await this.store.putTenantKey(tenantId, row); // loser of a race gets false and reads the winner's key below
          rows = await this.store.getTenantKeys(tenantId);
        }
        return new Map(rows.map((r) => [r.version, open(this.master.get(r.masterKeyId), this.wrapAad(tenantId, r.version), unb64(r.wrapped))]));
      })();
      p.catch(() => this.cache.delete(tenantId));
      this.cache.set(tenantId, p);
    }
    return p;
  }
  /** Forget cached keys (after a rotation by another process). */
  forget(tenantId?: string) { if (tenantId) this.cache.delete(tenantId); else this.cache.clear(); }

  private async current(tenantId: string) { const m = await this.load(tenantId); const v = Math.max(...m.keys()); return { v, key: m.get(v)! }; }
  private async byVersion(tenantId: string, v: number) { const k = (await this.load(tenantId)).get(v); if (!k) throw new CryptoError('UNKNOWN_KEY_VERSION'); return k; }

  async encryptValue(tenantId: string, aad: string, value: unknown): Promise<string> {
    const { v, key } = await this.current(tenantId);
    return `${PREFIX}${v}:${b64(seal(key, `${tenantId}|${aad}`, Buffer.from(JSON.stringify(value ?? null))))}`;
  }
  isEncrypted(x: unknown): x is string { return typeof x === 'string' && x.startsWith(PREFIX); }
  async decryptValue(tenantId: string, aad: string, s: string): Promise<unknown> {
    const [, , ver, body] = s.split(':'); if (!ver || !body) throw new CryptoError('BAD_CIPHERTEXT');
    return JSON.parse(open(await this.byVersion(tenantId, Number(ver)), `${tenantId}|${aad}`, unb64(body)).toString());
  }
  async encryptBytes(tenantId: string, aad: string, bytes: Uint8Array): Promise<Uint8Array> {
    const { v, key } = await this.current(tenantId);
    const ver = Buffer.alloc(4); ver.writeUInt32BE(v);
    return new Uint8Array(Buffer.concat([MAGIC, ver, seal(key, `${tenantId}|${aad}`, Buffer.from(bytes))]));
  }
  isEncryptedBytes(b: Uint8Array) { return b.length > 32 && Buffer.from(b.subarray(0, 4)).equals(MAGIC); }
  async decryptBytes(tenantId: string, aad: string, bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.isEncryptedBytes(bytes)) return bytes; // stored before encryption was switched on
    const buf = Buffer.from(bytes);
    return new Uint8Array(open(await this.byVersion(tenantId, buf.readUInt32BE(4)), `${tenantId}|${aad}`, buf.subarray(8)));
  }

  /** New data key version for a tenant: new writes use it, old data stays readable. Run `reencrypt` to migrate old data. */
  async rotateDataKey(tenantId: string): Promise<number> {
    const m = await this.load(tenantId); const v = Math.max(0, ...m.keys()) + 1;
    const ok = await this.store.putTenantKey(tenantId, { version: v, masterKeyId: this.master.currentId, wrapped: b64(seal(this.master.get(this.master.currentId), this.wrapAad(tenantId, v), randomBytes(32))), createdAt: this.now() });
    this.forget(tenantId); return ok ? v : (await this.current(tenantId)).v;
  }
  /** Re-wraps one stored data key under the current master key (master rotation). Pure function: caller persists it. */
  rewrap(tenantId: string, row: TenantKey): TenantKey {
    const dek = open(this.master.get(row.masterKeyId), this.wrapAad(tenantId, row.version), unb64(row.wrapped));
    return { ...row, masterKeyId: this.master.currentId, wrapped: b64(seal(this.master.get(this.master.currentId), this.wrapAad(tenantId, row.version), dek)) };
  }
}
