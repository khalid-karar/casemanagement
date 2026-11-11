import { createHash } from 'node:crypto';
import { NajizError } from './types';
import type { FilingPacket, NajizEvent, NajizGateway, NajizRegistry, NajizStatus, SubmitResult, UpdatesResult } from './types';

/**
 * SIMULATED Najiz. It exists so the whole case workflow (submit, approvals, sync, hearings, judgment, failure
 * handling) can be built, tested and demonstrated before a client has Najiz access. It is NOT Najiz: it knows nothing
 * of the real services, its identifiers are fake (prefix SIM-), and the server refuses it when NODE_ENV=production.
 *
 * Progress is driven by the caller (`advance`) so tests are deterministic.
 */
export class SimulatedNajiz implements NajizGateway {
  readonly name = 'SIMULATED-NAJIZ';
  readonly simulated = true;
  readonly configured = true;
  private filings = new Map<string, { key: string; status: NajizStatus; caseNo?: string; events: NajizEvent[]; step: number }>();
  private byKey = new Map<string, string>();
  /** Failures to inject on upcoming calls, consumed in order. */
  private faults: NajizError[] = [];
  /** Every packet received, for assertions. */
  readonly received: FilingPacket[] = [];

  failNext(...errors: NajizError[]) { this.faults.push(...errors); }

  async submitFiling(p: FilingPacket): Promise<SubmitResult> {
    const fault = this.faults.shift();
    if (fault) {
      // An ambiguous fault models "the filing arrived but the answer was lost": it is stored, then the error is raised.
      if (fault.code === 'AMBIGUOUS') this.store(p);
      throw fault;
    }
    const ref = this.store(p);
    const f = this.filings.get(ref)!;
    return { najizRef: ref, status: f.status, acceptedAt: '2026-11-10T08:00:00.000Z' };
  }

  private store(p: FilingPacket): string {
    this.received.push(p);
    const dup = this.byKey.get(p.idempotencyKey);
    if (dup) return dup; // same key: same filing, as a well-behaved service would
    const ref = 'SIM-' + createHash('sha256').update(p.idempotencyKey).digest('hex').slice(0, 10).toUpperCase();
    this.filings.set(ref, { key: p.idempotencyKey, status: 'RECEIVED', events: [], step: 0 });
    this.byKey.set(p.idempotencyKey, ref);
    return ref;
  }

  /** Moves a filing one step along: accepted, hearing scheduled, judgment issued. */
  advance(ref: string, to?: 'REJECTED') {
    const f = this.filings.get(ref);
    if (!f) throw new Error('unknown simulated filing');
    if (to === 'REJECTED') { f.status = 'REJECTED'; return; }
    f.step++;
    if (f.step === 1) { f.status = 'ACCEPTED'; f.caseNo = 'SIM-CASE-' + ref.slice(4); }
    if (f.step === 2) { f.status = 'HEARING_SCHEDULED'; f.events.push({ eventId: `${ref}-h1`, kind: 'HEARING', at: '2026-11-20T09:00:00.000Z', hearingAt: '2026-12-01T09:00:00.000Z', summary: 'SIMULATED: first session scheduled' }); }
    if (f.step === 3) { f.status = 'JUDGMENT_ISSUED'; f.events.push({ eventId: `${ref}-j1`, kind: 'JUDGMENT', at: '2026-12-02T09:00:00.000Z', summary: 'SIMULATED: judgment issued', document: { name: 'judgment-simulated.txt', mime: 'text/plain; charset=utf-8', bytes: new TextEncoder().encode('SIMULATED JUDGMENT: not a court document.') } }); }
  }

  async fetchUpdates(ref: string): Promise<UpdatesResult> {
    const fault = this.faults.shift();
    if (fault) throw fault;
    const f = this.filings.get(ref);
    if (!f) throw new NajizError('REJECTED', 'UNKNOWN_REFERENCE');
    return { status: f.status, ...(f.caseNo ? { courtCaseNumber: f.caseNo } : {}), events: f.events };
  }
}

/** Serves the simulator to every tenant. Used only in dev and QA. */
export const simulatorRegistry = (gw: SimulatedNajiz = new SimulatedNajiz()): NajizRegistry & { gateway: SimulatedNajiz } => ({ gateway: gw, gatewayFor: () => gw, claimantFor: (t) => ({ role: 'CLAIMANT', kind: 'ORGANISATION', identifierType: 'UNIFIED_NATIONAL_NUMBER', identifier: 'SIM-700000000', name: `SIMULATED claimant (${t})` }) });
