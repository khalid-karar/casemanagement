import { addArtifact, canAccess, setFields } from '../engine';
import type { Actor, CaseState } from '../engine';
import { CASE_TYPES } from '../case-types';
import type { Repo } from '../api/repo';
import { NajizError } from './types';
import type { NajizGateway } from './types';
import { NajizRuleError, importUpdates, najizState } from './workflow';

export type SyncOutcome =
  | { ok: true; status: string; imported: number; case: CaseState }
  | { ok: false; error: 'NOT_FOUND' | 'UNAVAILABLE' | 'REJECTED' | string };

/** The background actor: reads and records what Najiz reports, never transitions a case. Walls still apply (LEGAL, PRIVILEGED clearance). */
export const najizSystemActor = (tenantId: string): Actor => ({ id: 'system:najiz-sync', kind: 'system', tenantId, departments: ['LEGAL'], roles: [], reportsTo: [], clearance: 'PRIVILEGED' });

/**
 * Fetches Najiz's updates for one SUBMITTED matter and records them. Idempotent. Used by the "sync" button and the scheduled job.
 * Deliberately no state transition: counsel records the hearing / judgment step under the normal guards.
 */
export async function syncCase(repo: Repo, gw: NajizGateway, actor: Actor, caseId: string, now: () => string): Promise<SyncOutcome> {
  const cs0 = await repo.tx(actor, async (tx) => { const c = await tx.getCase(caseId); return c && c.tenantId === actor.tenantId && canAccess(actor, c, 'write').allowed ? c : undefined; });
  if (!cs0 || cs0.caseTypeKey !== 'legal.matter') return { ok: false, error: 'NOT_FOUND' };
  const st = najizState(cs0);
  if (st.state !== 'SUBMITTED') throw new NajizRuleError('NOT_SUBMITTED');
  let updates;
  try { updates = await gw.fetchUpdates(st.najizRef); }
  catch (e) { return { ok: false, error: e instanceof NajizError ? e.code : 'UNAVAILABLE' }; }
  const imp = importUpdates(cs0, updates, gw.simulated);
  for (const d of imp.documents) await repo.putCaseDocument(actor, caseId, { ...d, uploadedBy: 'najiz', uploadedAt: now() });
  const out = await repo.tx(actor, async (tx) => {
    let cs = await tx.getCase(caseId, true);
    if (!cs) return undefined;
    for (const a of imp.artifacts) {
      if (cs.artifacts.some((x) => x.id === a.id)) continue; // a concurrent sync already imported it
      const m = addArtifact(cs, a, actor, now());
      await tx.saveCase(m.case, m.event); cs = m.case;
    }
    // Fill the court case number only if it is empty: never overwrite what counsel recorded.
    if (imp.courtCaseNumber && !cs.fields['courtCaseNumber']) {
      try { const m = setFields(cs, { courtCaseNumber: imp.courtCaseNumber }, actor, now(), CASE_TYPES[cs.caseTypeKey]!); await tx.saveCase(m.case, m.event); cs = m.case; } catch { /* locked or invalid: leave it */ }
    }
    return cs;
  });
  return out ? { ok: true, status: updates.status, imported: imp.artifacts.filter((a) => a.type !== 'najiz_status').length, case: out } : { ok: false, error: 'NOT_FOUND' };
}

/** One pass over a client's submitted matters. A failure on one matter never stops the others. */
export async function syncTenant(repo: Repo, gw: NajizGateway, tenantId: string, now: () => string): Promise<{ checked: number; imported: number; failed: number }> {
  const actor = najizSystemActor(tenantId);
  const ids = (await repo.tx(actor, (tx) => tx.listCases())).filter((c) => c.caseTypeKey === 'legal.matter' && najizState(c).state === 'SUBMITTED').map((c) => c.id);
  let imported = 0, failed = 0;
  for (const id of ids) {
    try { const r = await syncCase(repo, gw, actor, id, now); if (r.ok) imported += r.imported; else failed++; }
    catch (e) { failed++; console.error(JSON.stringify({ event: 'najiz_sync_failed', tenant: tenantId, case: id, error: (e as Error).message })); }
  }
  return { checked: ids.length, imported, failed };
}
