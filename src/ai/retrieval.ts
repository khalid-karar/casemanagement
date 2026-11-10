import { canAccess, redactForActor } from '../engine/permissions';
import type { Actor, CaseState, CaseTypeDefinition } from '../engine/types';

export interface Chunk {
  id: string;
  caseId: string;
  text: string;
}

/**
 * Permission-filtered retrieval. The actor's access is checked BEFORE anything is read into a
 * chunk, and fields are redacted for that actor, so the model can never see what the user can't.
 */
export function buildChunks(
  cases: CaseState[],
  defs: Record<string, CaseTypeDefinition>,
  actor: Actor,
): Chunk[] {
  const out: Chunk[] = [];
  for (const raw of cases) {
    if (!canAccess(actor, raw, 'read').allowed) continue;
    const def = defs[raw.caseTypeKey];
    if (!def) continue;
    const c = redactForActor(def, raw, actor);
    const fields = Object.entries(c.fields).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
    out.push({ id: `${c.id}:fields`, caseId: c.id, text: `Case ${c.id} (${def.key}, state ${c.state})\n${fields}` });
    for (const a of c.artifacts) {
      out.push({ id: `${c.id}:${a.id}`, caseId: c.id, text: `Case ${c.id} artifact ${a.type} at ${a.createdAt}` });
    }
  }
  return out;
}

const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/** Simple lexical ranking; swap for pgvector hybrid search without changing the contract. */
export function rank(chunks: Chunk[], query: string, k = 8): Chunk[] {
  const q = new Set(tokens(query));
  return chunks
    .map((c) => ({ c, score: tokens(c.text).filter((t) => q.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}
