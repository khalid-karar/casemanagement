import { REDACTED, canAccess, redactForActor } from '../engine';
import type { CaseState, CaseTypeDefinition } from '../engine';
import type { Principal } from './auth';
import { summarise } from './summary';

/**
 * The board pack: what senior management and an audit committee ask for, and nothing that identifies a person or a case.
 * Every figure is a count, a rate or an average. It covers the cases the requester may read, so a number never includes
 * a case behind a wall the requester is outside of; the report says so rather than pretending to be organisation-wide.
 */
export interface BoardReport {
  period: { from: string; to: string };
  scope: 'READABLE_CASES';
  opened: number; closed: number; openNow: number;
  /** Of cases closed in the period with a recorded outcome the requester may see: how many were upheld. */
  substantiation: { decided: number; substantiated: number; rate: number | null };
  avgDaysToClose: number | null;
  aging: { bucket: '0-30' | '31-60' | '61-90' | '90+'; count: number }[];
  pastTarget: number; overdueActions: number;
  byDomain: { domain: string; opened: number; closed: number; open: number }[];
  byOutcome: { outcome: string; count: number }[];
  reports?: { received: number; awaitingTriage: number };
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function boardReport(
  cases: CaseState[], user: Principal, defs: Record<string, CaseTypeDefinition>, nowIso: string, period: { from: string; to: string },
): BoardReport {
  const from = Date.parse(`${period.from}T00:00:00+03:00`), to = Date.parse(`${period.to}T23:59:59.999+03:00`);
  const within = (iso: string | undefined) => iso !== undefined && Date.parse(iso) >= from && Date.parse(iso) <= to;
  const mine = cases.filter((c) => defs[c.caseTypeKey] && canAccess(user, c, 'read').allowed);
  const domains = new Map<string, { opened: number; closed: number; open: number }>();
  const dom = (d: string) => { let x = domains.get(d); if (!x) domains.set(d, (x = { opened: 0, closed: 0, open: 0 })); return x; };
  const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const outcomes = new Map<string, number>();
  let opened = 0, closed = 0, openNow = 0, pastTarget = 0, overdueActions = 0, closeDays = 0, closeN = 0, decided = 0, substantiated = 0;

  for (const c of mine) {
    const def = defs[c.caseTypeKey]!;
    const s = summarise(c, user, def, nowIso);
    const d = dom(def.domain);
    if (within(c.createdAt)) { opened++; d.opened++; }
    if (s.stateKind === 'OPEN') {
      openNow++; d.open++;
      const age = s.ageDays;
      aging[age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+']++;
      if (s.slaStatus === 'BREACHED') pastTarget++;
      overdueActions += s.overdueActions;
    } else if (within(c.closedAt)) {
      closed++; d.closed++;
      closeDays += Math.max(0, (Date.parse(c.closedAt!) - Date.parse(c.createdAt)) / DAY); closeN++;
      const o = redactForActor(def, c, user).fields['outcome'];
      if (typeof o === 'string' && o !== REDACTED) {
        decided++; outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
        if (o.startsWith('SUBSTANTIATED')) substantiated++;
      }
    }
  }
  return {
    period, scope: 'READABLE_CASES', opened, closed, openNow,
    substantiation: { decided, substantiated, rate: decided ? round1((substantiated / decided) * 100) : null },
    avgDaysToClose: closeN ? round1(closeDays / closeN) : null,
    aging: (Object.keys(aging) as (keyof typeof aging)[]).map((bucket) => ({ bucket, count: aging[bucket] })),
    pastTarget, overdueActions,
    byDomain: [...domains].map(([domain, v]) => ({ domain, ...v })).sort((a, b) => a.domain.localeCompare(b.domain)),
    byOutcome: [...outcomes].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count),
  };
}

export function boardCsv(r: BoardReport): string {
  const cell = (v: unknown) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const rows: unknown[][] = [
    ['section', 'item', 'value'],
    ['period', 'from', r.period.from], ['period', 'to', r.period.to],
    ['volume', 'opened', r.opened], ['volume', 'closed', r.closed], ['volume', 'open_now', r.openNow],
    ['outcomes', 'decided', r.substantiation.decided], ['outcomes', 'substantiated', r.substantiation.substantiated], ['outcomes', 'substantiation_rate_pct', r.substantiation.rate],
    ['time', 'avg_days_to_close', r.avgDaysToClose],
    ...r.aging.map((a) => ['aging_days', a.bucket, a.count]),
    ['risk', 'past_target_date', r.pastTarget], ['risk', 'overdue_corrective_actions', r.overdueActions],
    ...r.byDomain.flatMap((d) => [['department_opened', d.domain, d.opened], ['department_closed', d.domain, d.closed], ['department_open', d.domain, d.open]]),
    ...r.byOutcome.map((o) => ['outcome', o.outcome, o.count]),
    ...(r.reports ? [['reports', 'received', r.reports.received], ['reports', 'awaiting_triage', r.reports.awaitingTriage]] : []),
  ];
  return '﻿' + rows.map((x) => x.map(cell).join(',')).join('\r\n') + '\r\n';
}
