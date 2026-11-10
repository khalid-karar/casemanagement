import { GENESIS_HASH, canonicalJson, sha256Hex } from './canonical';

export class CustodyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CustodyError';
  }
}

export interface CustodyEntry {
  seq: number;
  at: string;
  fromId: string;
  toId: string;
  reason: string;
  prevHash: string;
  hash: string;
}

export interface EvidenceItem {
  id: string;
  caseId: string;
  tenantId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Hash of the content at acquisition. Everything downstream (court export, referral) cites this. */
  sha256: string;
  collectedBy: string;
  collectedAt: string;
  sourceDescription?: string;
  custody: CustodyEntry[];
}

function custodyHash(sha256: string, e: Omit<CustodyEntry, 'hash'>): string {
  // Binding the content hash into every link means a swapped file breaks the whole chain.
  return sha256Hex(canonicalJson({ evidenceSha256: sha256, ...e }));
}

export function registerEvidence(input: {
  id: string;
  caseId: string;
  tenantId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  collectedBy: string;
  collectedAt: string;
  sourceDescription?: string;
}): EvidenceItem {
  const sha256 = sha256Hex(input.bytes);
  const first: Omit<CustodyEntry, 'hash'> = {
    seq: 1,
    at: input.collectedAt,
    fromId: 'SOURCE',
    toId: input.collectedBy,
    reason: 'collected',
    prevHash: GENESIS_HASH,
  };
  return {
    id: input.id,
    caseId: input.caseId,
    tenantId: input.tenantId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    collectedBy: input.collectedBy,
    collectedAt: input.collectedAt,
    ...(input.sourceDescription ? { sourceDescription: input.sourceDescription } : {}),
    custody: [{ ...first, hash: custodyHash(sha256, first) }],
  };
}

export function currentHolder(item: EvidenceItem): string {
  return item.custody[item.custody.length - 1]!.toId;
}

export function transferCustody(
  item: EvidenceItem,
  t: { fromId: string; toId: string; reason: string; at: string },
): EvidenceItem {
  if (t.fromId !== currentHolder(item)) {
    throw new CustodyError('NOT_CURRENT_HOLDER', `${t.fromId} does not hold evidence ${item.id}`);
  }
  const prev = item.custody[item.custody.length - 1]!;
  const entry: Omit<CustodyEntry, 'hash'> = {
    seq: prev.seq + 1,
    at: t.at,
    fromId: t.fromId,
    toId: t.toId,
    reason: t.reason,
    prevHash: prev.hash,
  };
  return { ...item, custody: [...item.custody, { ...entry, hash: custodyHash(item.sha256, entry) }] };
}

/** True only if these bytes are exactly what was acquired. */
export function verifyEvidenceBytes(item: EvidenceItem, bytes: Uint8Array): boolean {
  return bytes.byteLength === item.sizeBytes && sha256Hex(bytes) === item.sha256;
}

export function verifyCustody(item: EvidenceItem): boolean {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < item.custody.length; i++) {
    const e = item.custody[i]!;
    if (e.seq !== i + 1 || e.prevHash !== prevHash) return false;
    const { hash, ...rest } = e;
    if (custodyHash(item.sha256, rest) !== hash) return false;
    prevHash = e.hash;
  }
  return item.custody.length > 0;
}
