import { randomUUID } from 'node:crypto';
import { canAccess } from '../engine';
import type { Actor, CaseState } from '../engine';
import type { NotificationKind, Person, Repo } from './repo';

export const personToActor = (p: Person): Actor => ({
  id: p.id, kind: p.kind === 'external' ? 'external' : 'human', tenantId: p.tenantId, departments: p.departments as Actor['departments'], roles: p.roles,
  reportsTo: p.reportsTo, clearance: p.clearance ?? 'STANDARD', ...(p.counselMatterIds?.length ? { counselMatterIds: p.counselMatterIds } : {}),
});

/**
 * Creates in-app notifications. A person is only ever notified about a case they are allowed to read, so a notification can
 * never reveal that a case exists to someone behind a wall. It carries no case content, only the kind of event.
 */
export function makeNotifier(repo: Repo, now: () => string) {
  return {
    async notify(cs: CaseState, recipients: (Person | undefined)[], kind: NotificationKind, actorId: string | null, dedupe?: string) {
      let sent = 0;
      for (const p of recipients) {
        if (!p || p.id === actorId || p.kind === 'ai' || p.kind === 'system') continue;
        if (!canAccess(personToActor(p), cs, 'read').allowed) continue;
        const ok = await repo.addNotification({ id: randomUUID(), tenantId: cs.tenantId, userId: p.id, kind, caseId: cs.id, actorId, dedupeKey: dedupe ?? null, createdAt: now() });
        if (ok) sent++;
      }
      return sent;
    },
  };
}
export type Notifier = ReturnType<typeof makeNotifier>;
