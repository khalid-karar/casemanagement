import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, fsyncSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../api/repo';

/**
 * Audit anchoring. Each case's audit trail is a hash chain, which proves internal consistency but cannot prove that
 * someone with database access did not rebuild a whole chain. Periodically we record every case's chain head
 * (case, seq, hash) to a sink OUTSIDE the database, itself chained. A later rewrite of history can then be detected:
 * the anchored (case, seq) must still hold the anchored hash.
 *
 * The sink is an interface: the file sink below is for development and for a mounted write-once volume; an object-store
 * sink with retention lock plugs in at deployment without touching anything else.
 */
export interface AnchorRecord {
  tenantId: string; at: string; heads: { caseId: string; seq: number; hash: string }[];
  /** Hash of the previous anchor record for this tenant ('' for the first): a deleted or edited anchor breaks the sequence. */
  prev: string; hash: string;
}
export interface AnchorSink {
  last(tenantId: string): Promise<AnchorRecord | undefined>;
  append(r: AnchorRecord): Promise<void>;
  all(tenantId: string): Promise<AnchorRecord[]>;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const recordHash = (r: Omit<AnchorRecord, 'hash'>) => sha(JSON.stringify([r.tenantId, r.at, r.heads, r.prev]));

export class FileAnchorSink implements AnchorSink {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  private path = (t: string) => join(this.dir, `anchors-${t.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
  async all(t: string) { const p = this.path(t); return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AnchorRecord) : []; }
  async last(t: string) { return (await this.all(t)).at(-1); }
  async append(r: AnchorRecord) {
    const fd = openSync(this.path(r.tenantId), 'a'); // append-only; fsync so a crash cannot lose an acknowledged anchor
    try { writeSync(fd, JSON.stringify(r) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
export class MemoryAnchorSink implements AnchorSink {
  records: AnchorRecord[] = [];
  async all(t: string) { return this.records.filter((r) => r.tenantId === t); }
  async last(t: string) { return (await this.all(t)).at(-1); }
  async append(r: AnchorRecord) { this.records.push(r); }
}

export async function anchorTenant(repo: Repo, sink: AnchorSink, tenantId: string, at: string): Promise<AnchorRecord> {
  const heads = await repo.tx(tenantId, async (tx) => {
    const out: AnchorRecord['heads'] = [];
    for (const c of await tx.listCases()) { const e = (await tx.getAudit(c.id)).at(-1); if (e) out.push({ caseId: c.id, seq: e.seq, hash: e.hash }); }
    return out.sort((a, b) => a.caseId.localeCompare(b.caseId));
  });
  const prev = (await sink.last(tenantId))?.hash ?? '';
  const base = { tenantId, at, heads, prev };
  const rec = { ...base, hash: recordHash(base) };
  await sink.append(rec);
  return rec;
}

export async function anchorAll(repo: Repo, sink: AnchorSink, at: string) {
  const done: string[] = [];
  for (const t of await repo.listTenants()) { await anchorTenant(repo, sink, t, at); done.push(t); }
  return done;
}

export type AnchorProblem = { at: string; kind: 'ANCHOR_CHAIN_BROKEN' | 'CASE_MISSING' | 'HISTORY_REWRITTEN' | 'ANCHOR_ALTERED'; caseId?: string; seq?: number };

/** Checks the anchors themselves, then checks the live database still agrees with every one of them. Empty result = consistent. */
export async function verifyAnchors(repo: Repo, sink: AnchorSink, tenantId: string): Promise<AnchorProblem[]> {
  const problems: AnchorProblem[] = [];
  const recs = await sink.all(tenantId);
  let prev = '';
  for (const r of recs) {
    if (r.prev !== prev) problems.push({ at: r.at, kind: 'ANCHOR_CHAIN_BROKEN' });
    if (recordHash({ tenantId: r.tenantId, at: r.at, heads: r.heads, prev: r.prev }) !== r.hash) problems.push({ at: r.at, kind: 'ANCHOR_ALTERED' });
    prev = r.hash;
  }
  const live = await repo.tx(tenantId, async (tx) => {
    const m = new Map<string, Map<number, string>>();
    for (const c of await tx.listCases()) m.set(c.id, new Map((await tx.getAudit(c.id)).map((e) => [e.seq, e.hash])));
    return m;
  });
  for (const r of recs) for (const h of r.heads) {
    const ch = live.get(h.caseId);
    if (!ch) problems.push({ at: r.at, kind: 'CASE_MISSING', caseId: h.caseId });
    else if (ch.get(h.seq) !== h.hash) problems.push({ at: r.at, kind: 'HISTORY_REWRITTEN', caseId: h.caseId, seq: h.seq });
  }
  return problems;
}
