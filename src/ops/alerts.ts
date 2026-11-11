import { SAUDI_CALENDAR, slaForCase } from '../engine';
import { CASE_TYPES } from '../case-types';
import type { Repo } from '../api/repo';
import { makeNotifier } from '../api/notify';
import { notifyTriagers } from '../api/report-notify';

/** A reporter who wrote last and has had no answer for this long is waiting on someone. */
export const REPORT_STALE_DAYS = 3;

/**
 * Deadline alerts. Run on a schedule; each alert is sent once (a dedupe key per case, step and status), so running it
 * often is safe. Targets are internal service levels (the Saudi working week), not legal deadlines.
 *  - step target close (80% elapsed) or passed: tell the assignee; if nobody is assigned, the role the step escalates to
 *  - corrective action overdue or due within 2 days: tell its owner
 */
export async function deadlineAlerts(repo: Repo, nowIso: string) {
  const notifier = makeNotifier(repo, () => nowIso);
  let sent = 0;
  for (const tenantId of await repo.listTenants()) {
    const people = await repo.listPeople(tenantId);
    const byId = new Map(people.map((p) => [p.id, p]));
    // Reports waiting on staff. The list reads columns only, so no message is opened to decide this.
    for (const r of await repo.reportTx(tenantId, (tx) => tx.list({ status: 'UNTRIAGED' }))) {
      if (!r.awaitingStaff || (Date.parse(nowIso) - Date.parse(r.updatedAt)) / 86400000 < REPORT_STALE_DAYS) continue;
      sent += await notifyTriagers(repo, people, tenantId, 'REPORT_STALE', r.id, `rep:${r.id}:stale:${r.updatedAt}`, nowIso);
    }
    const cases = await repo.tx(tenantId, (tx) => tx.listCases()); // trusted internal pass: tenant isolation only
    for (const cs of cases) {
      const def = CASE_TYPES[cs.caseTypeKey]; if (!def) continue;
      if ((def.states.find((s) => s.key === cs.state)?.kind ?? 'OPEN') !== 'OPEN') continue;
      const sla = slaForCase(def, cs, SAUDI_CALENDAR, nowIso);
      if (sla && sla.status !== 'ON_TRACK') {
        const assignee = cs.assignee ? byId.get(cs.assignee.id) : undefined;
        const who = assignee ? [assignee] : people.filter((p) => p.roles.includes(sla.escalateToRole));
        sent += await notifier.notify(cs, who, sla.status === 'BREACHED' ? 'SLA_BREACH' : 'SLA_RISK', null, `sla:${cs.id}:${cs.state}:${sla.status}`);
      }
      for (const a of cs.actions) {
        if (a.status !== 'OPEN' || !a.dueDate || !a.ownerId) continue;
        const days = (Date.parse(a.dueDate + 'T23:59:59+03:00') - Date.parse(nowIso)) / 86400000;
        if (days > 2) continue;
        sent += await notifier.notify(cs, [byId.get(a.ownerId)], 'ACTION_DUE', null, `act:${cs.id}:${a.id}:${days < 0 ? 'late' : 'soon'}`);
      }
    }
  }
  return { sent };
}
