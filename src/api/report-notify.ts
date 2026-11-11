import { randomUUID } from 'node:crypto';
import type { NotificationKind, Person, Repo } from './repo';

/**
 * Tells the organisation's ethics officers that a report needs them. A report is not a case, so there is no case access to
 * check: the audience is "people holding ethics_officer in this tenant", the same rule that gates the inbox itself.
 * The notification carries the report's number and the kind of event, never a word of what was said.
 */
export async function notifyTriagers(
  repo: Repo, people: Person[], tenantId: string, kind: Extract<NotificationKind, `REPORT_${string}`>, reportId: string, dedupe: string, at: string,
): Promise<number> {
  let sent = 0;
  for (const p of people) {
    if (p.tenantId !== tenantId || p.kind !== 'human' || !p.roles.includes('ethics_officer')) continue;
    if (await repo.addNotification({ id: randomUUID(), tenantId, userId: p.id, kind, caseId: reportId, actorId: null, dedupeKey: dedupe, createdAt: at })) sent++;
  }
  return sent;
}
