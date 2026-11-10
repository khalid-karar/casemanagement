/**
 * Najiz (Ministry of Justice) gateway: OUR model of a court filing and its progress.
 *
 * The rest of the platform only ever sees these types. How they map onto Najiz's real services (court taxonomy,
 * request and response fields) lives in exactly one place, `contract.ts`, which is filled in from the Swagger
 * documents the Najiz Developers Portal issues once a client organisation has its account and data-sharing
 * agreement. Until then the only runnable gateway is the clearly labelled simulator.
 */
export type Forum = 'LABOUR_COURT' | 'CRIMINAL_COURT' | 'COMMERCIAL_COURT' | 'BOARD_OF_GRIEVANCES' | 'OTHER';

export interface FilingParty {
  role: 'CLAIMANT' | 'DEFENDANT';
  kind: 'PERSON' | 'ORGANISATION';
  identifierType: 'NATIONAL_ID' | 'IQAMA' | 'CR' | 'UNIFIED_NATIONAL_NUMBER' | 'OTHER';
  identifier: string;
  name: string;
}

export interface FilingAttachment { name: string; mime: string; sha256: string; size: number; bytes: Uint8Array }

/** Everything that leaves the platform for Najiz. Built from an explicit allowlist, never from "the whole case". */
export interface FilingPacket {
  /** Stable per attempt. Sent to Najiz so a repeated request can be recognised, if the service supports it. */
  idempotencyKey: string;
  matterId: string;
  forum: Forum;
  title: string;
  claimSubject: string;
  claimValueSar?: number;
  parties: FilingParty[];
  /** First is the filing document itself, the rest are exhibits. */
  attachments: FilingAttachment[];
}

export type NajizStatus = 'RECEIVED' | 'ACCEPTED' | 'REJECTED' | 'UNDER_REVIEW' | 'HEARING_SCHEDULED' | 'JUDGMENT_ISSUED' | 'CLOSED';

export interface NajizEvent {
  /** Unique and stable per event at Najiz: used to make syncing idempotent. */
  eventId: string;
  kind: 'HEARING' | 'JUDGMENT' | 'NOTICE';
  at: string;
  summary: string;
  /** HEARING: when the session is. */
  hearingAt?: string;
  /** JUDGMENT / NOTICE may carry a document. */
  document?: { name: string; mime: string; bytes: Uint8Array };
}

export interface SubmitResult { najizRef: string; status: NajizStatus; acceptedAt: string; courtCaseNumber?: string }
export interface UpdatesResult { status: NajizStatus; courtCaseNumber?: string; events: NajizEvent[] }

export interface NajizGateway {
  readonly name: string;
  /** True only for the simulator. Everything it produces is labelled, and it is refused in production. */
  readonly simulated: boolean;
  /** False when the wire mapping is not installed yet: callers refuse before recording anything. */
  readonly configured: boolean;
  submitFiling(packet: FilingPacket): Promise<SubmitResult>;
  fetchUpdates(najizRef: string): Promise<UpdatesResult>;
}

/**
 * - REJECTED      Najiz received it and said no: definitive, safe to correct and resubmit.
 * - UNAVAILABLE   provably not processed (could not connect, refused before processing): safe to retry.
 * - AMBIGUOUS     the request may or may not have been processed (timeout, dropped connection, 5xx after sending).
 *                 NEVER retried automatically: a lawsuit filed twice is not undoable. A person reconciles.
 * - AUTH          our credentials were refused.
 * - CONTRACT_NOT_CONFIGURED / NOT_ENABLED   setup, not runtime, problems.
 */
export type NajizErrorCode = 'REJECTED' | 'UNAVAILABLE' | 'AMBIGUOUS' | 'AUTH' | 'CONTRACT_NOT_CONFIGURED' | 'NOT_ENABLED';
export class NajizError extends Error {
  constructor(public readonly code: NajizErrorCode, message?: string, public readonly detail?: string) {
    super(message ?? code);
    this.name = 'NajizError';
  }
}

/** Which gateway serves which client. Each client organisation has its own Najiz account and credentials. */
export interface NajizRegistry {
  gatewayFor(tenantId: string): NajizGateway | undefined;
  /** The client organisation as claimant. Comes from that client's Najiz onboarding (its unified national number), not from case data. */
  claimantFor(tenantId: string): FilingParty | undefined;
}
