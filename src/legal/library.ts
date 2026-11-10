import type { Instrument, InstrumentVersion, LegalActor, Provision, RuleBinding } from './types';
import { provisionHash, sourceHash, splitArticles } from './ingest';
import type { Proposal } from './extraction';

export class LegalError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Roles: legal_content_editor uploads; legal_verifier (counsel) verifies. Never the same person. */
export class LegalLibrary {
  instruments = new Map<string, Instrument>();
  versions = new Map<string, InstrumentVersion>();
  bindings = new Map<string, RuleBinding>();
  proposals = new Map<string, Proposal>();
  log: Array<{ at: string; actorId: string; type: string; ref: string }> = [];

  addInstrument(i: Instrument, actor: LegalActor, at: string) {
    this.guardScope(i.tenantId, actor);
    if (!actor.roles.includes('legal_content_editor')) throw new LegalError('ROLE_REQUIRED:legal_content_editor');
    this.instruments.set(i.id, i);
    this.log.push({ at, actorId: actor.id, type: 'instrument.added', ref: i.id });
  }

  /** Upload raw text; articles are split automatically into a DRAFT awaiting human review. */
  uploadVersion(
    input: { id: string; instrumentId: string; versionLabel: string; effectiveFrom: string; amendedBy?: string; rawText: string; sourceFileSha256?: string; provisions?: Provision[] },
    actor: LegalActor,
    at: string,
  ) {
    const inst = this.mustInstrument(input.instrumentId);
    this.guardScope(inst.tenantId, actor);
    if (!actor.roles.includes('legal_content_editor')) throw new LegalError('ROLE_REQUIRED:legal_content_editor');
    const split = input.provisions ? { provisions: input.provisions, warnings: [] as string[] } : splitArticles(input.rawText);
    const v: InstrumentVersion = {
      id: input.id,
      instrumentId: input.instrumentId,
      versionLabel: input.versionLabel,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      ...(input.amendedBy ? { amendedBy: input.amendedBy } : {}),
      sourceHash: sourceHash(input.rawText),
      ...(input.sourceFileSha256 ? { sourceFileSha256: input.sourceFileSha256 } : {}),
      provisions: split.provisions,
      status: 'DRAFT',
      uploadedBy: actor.id,
    };
    this.versions.set(v.id, v);
    this.log.push({ at, actorId: actor.id, type: 'version.uploaded', ref: v.id });
    return { version: v, warnings: split.warnings };
  }

  /** The editor may correct a draft; any edit resets review. Verified text is immutable. */
  editProvision(versionId: string, number: string, patch: Partial<Provision>, actor: LegalActor, at: string) {
    const v = this.mustVersion(versionId);
    if (v.status === 'VERIFIED' || v.status === 'SUPERSEDED') throw new LegalError('VERIFIED_TEXT_IMMUTABLE');
    const inst = this.mustInstrument(v.instrumentId);
    this.guardScope(inst.tenantId, actor);
    if (!actor.roles.includes('legal_content_editor')) throw new LegalError('ROLE_REQUIRED:legal_content_editor');
    v.provisions = v.provisions.map((p) => (p.number === number ? { ...p, ...patch } : p));
    v.status = 'DRAFT';
    this.log.push({ at, actorId: actor.id, type: 'provision.edited', ref: `${versionId}#${number}` });
    return v;
  }

  submitForReview(versionId: string, actor: LegalActor, at: string) {
    const v = this.mustVersion(versionId);
    if (v.status !== 'DRAFT') throw new LegalError('NOT_DRAFT');
    if (v.provisions.length === 0) throw new LegalError('NO_PROVISIONS');
    v.status = 'UNDER_REVIEW';
    this.log.push({ at, actorId: actor.id, type: 'version.submitted', ref: versionId });
    return v;
  }

  /** Dual control: the verifier must be a different person from the uploader. */
  verify(versionId: string, actor: LegalActor, note: string, at: string) {
    const v = this.mustVersion(versionId);
    const inst = this.mustInstrument(v.instrumentId);
    this.guardScope(inst.tenantId, actor);
    if (!actor.roles.includes('legal_verifier')) throw new LegalError('ROLE_REQUIRED:legal_verifier');
    if (v.status !== 'UNDER_REVIEW') throw new LegalError('NOT_UNDER_REVIEW');
    if (v.uploadedBy === actor.id) throw new LegalError('VERIFIER_MUST_DIFFER_FROM_UPLOADER');
    // Close the previous current version at the day before this one takes effect.
    for (const o of this.versions.values()) {
      if (o.instrumentId === v.instrumentId && o.id !== v.id && o.status === 'VERIFIED' && o.effectiveTo === null && o.effectiveFrom < v.effectiveFrom) {
        o.effectiveTo = dayBefore(v.effectiveFrom);
      }
    }
    v.status = 'VERIFIED';
    v.verifiedBy = actor.id;
    v.verifiedAt = at;
    v.reviewNote = note;
    this.log.push({ at, actorId: actor.id, type: 'version.verified', ref: versionId });
    this.flagStaleBindings(v);
    return v;
  }

  reject(versionId: string, actor: LegalActor, note: string, at: string) {
    const v = this.mustVersion(versionId);
    if (!actor.roles.includes('legal_verifier')) throw new LegalError('ROLE_REQUIRED:legal_verifier');
    if (v.status !== 'UNDER_REVIEW') throw new LegalError('NOT_UNDER_REVIEW');
    v.status = 'REJECTED';
    v.reviewNote = note;
    this.log.push({ at, actorId: actor.id, type: 'version.rejected', ref: versionId });
    return v;
  }

  /** Verified version in force on a date (event date, not today). */
  inForce(instrumentId: string, date: string): InstrumentVersion | undefined {
    return [...this.versions.values()].find(
      (v) => v.instrumentId === instrumentId && v.status === 'VERIFIED' && v.effectiveFrom <= date && (v.effectiveTo === null || date <= v.effectiveTo),
    );
  }

  /** Only verified provisions visible to a tenant (platform baseline + its own policies). */
  verifiedProvisions(tenantId: string, date: string) {
    const out: Array<{ instrument: Instrument; version: InstrumentVersion; provision: Provision }> = [];
    for (const inst of this.instruments.values()) {
      if (inst.tenantId !== null && inst.tenantId !== tenantId) continue;
      const v = this.inForce(inst.id, date);
      if (!v) continue;
      for (const provision of v.provisions) out.push({ instrument: inst, version: v, provision });
    }
    return out;
  }

  // ---- AI proposals: visible only to reviewers of the instrument's own scope ----
  canSeeProposals(versionId: string, actor: LegalActor) {
    const v = this.mustVersion(versionId);
    const inst = this.mustInstrument(v.instrumentId);
    const scoped = inst.tenantId === null ? actor.tenantId === 'platform' : actor.tenantId === inst.tenantId;
    return scoped && (actor.roles.includes('legal_verifier') || actor.roles.includes('legal_content_editor'));
  }
  storeProposals(list: Proposal[]) { for (const p of list) this.proposals.set(p.id, p); }
  proposalsFor(versionId: string, actor: LegalActor) {
    if (!this.canSeeProposals(versionId, actor)) throw new LegalError('SCOPE_MISMATCH');
    return [...this.proposals.values()].filter((p) => p.versionId === versionId);
  }
  decideProposal(id: string, accept: boolean, actor: LegalActor) {
    const p = this.proposals.get(id);
    if (!p) throw new LegalError('UNKNOWN_PROPOSAL');
    if (!this.canSeeProposals(p.versionId, actor) || !actor.roles.includes('legal_verifier')) throw new LegalError('ROLE_REQUIRED:legal_verifier');
    p.status = accept ? 'ACCEPTED' : 'REJECTED';
    p.decidedBy = actor.id;
    return p;
  }
  versionsFor(actor: LegalActor) {
    return [...this.versions.values()].filter((v) => this.canSeeProposals(v.id, actor));
  }

  // ---- Rule bindings -------------------------------------------------------
  bindRule(b: Omit<RuleBinding, 'stale' | 'approvedTextHash'>, actor: LegalActor, at: string) {
    if (!actor.roles.includes('legal_verifier')) throw new LegalError('ROLE_REQUIRED:legal_verifier');
    const inst = this.mustInstrument(b.instrumentId);
    const v = this.inForce(inst.id, at.slice(0, 10));
    const p = v?.provisions.find((x) => x.number === b.provisionNumber);
    if (!v || !p) throw new LegalError('PROVISION_NOT_VERIFIED_IN_FORCE');
    const rb: RuleBinding = { ...b, approvedTextHash: provisionHash(p), stale: false };
    this.bindings.set(rb.id, rb);
    return rb;
  }

  /** Counsel re-approves a rule against the new text after reviewing the diff. */
  reapproveBinding(bindingId: string, actor: LegalActor, at: string) {
    if (!actor.roles.includes('legal_verifier')) throw new LegalError('ROLE_REQUIRED:legal_verifier');
    const b = this.bindings.get(bindingId);
    if (!b) throw new LegalError('UNKNOWN_BINDING');
    const p = this.inForce(b.instrumentId, at.slice(0, 10))?.provisions.find((x) => x.number === b.provisionNumber);
    if (!p) throw new LegalError('PROVISION_NOT_VERIFIED_IN_FORCE');
    b.approvedTextHash = provisionHash(p);
    b.stale = false;
    return b;
  }

  staleBindings() { return [...this.bindings.values()].filter((b) => b.stale); }

  private flagStaleBindings(v: InstrumentVersion) {
    for (const b of this.bindings.values()) {
      if (b.instrumentId !== v.instrumentId) continue;
      const p = v.provisions.find((x) => x.number === b.provisionNumber);
      // Missing (repealed) or changed text both require counsel to re-approve the rule.
      if (!p || provisionHash(p) !== b.approvedTextHash) b.stale = true;
    }
  }

  private guardScope(instTenant: string | null, actor: LegalActor) {
    // Tenant policy is managed by that tenant; the platform baseline by platform staff (tenantId 'platform').
    if (instTenant === null ? actor.tenantId !== 'platform' : actor.tenantId !== instTenant) throw new LegalError('SCOPE_MISMATCH');
  }
  private mustInstrument(id: string) { const i = this.instruments.get(id); if (!i) throw new LegalError('UNKNOWN_INSTRUMENT'); return i; }
  private mustVersion(id: string) { const v = this.versions.get(id); if (!v) throw new LegalError('UNKNOWN_VERSION'); return v; }
}

function dayBefore(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
