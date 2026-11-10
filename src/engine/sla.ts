import type { CaseState, CaseTypeDefinition, LocalizedText } from './types';

/**
 * Saudi working calendar. Fri/Sat weekend; holidays are tenant-supplied (they move with the
 * Hijri calendar and royal decree, so they are never hard-coded). All day boundaries are
 * evaluated in Asia/Riyadh (UTC+3, no daylight saving).
 */
export interface BusinessCalendar {
  /** 0 = Sunday … 6 = Saturday */
  weekend: number[];
  /** Local dates, YYYY-MM-DD */
  holidays: string[];
}

export const SAUDI_CALENDAR: BusinessCalendar = { weekend: [5, 6], holidays: [] };

const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

function localDay(ms: number): { date: string; dow: number } {
  const d = new Date(ms + RIYADH_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}

export function isBusinessDay(iso: string, cal: BusinessCalendar): boolean {
  const { date, dow } = localDay(Date.parse(iso));
  return !cal.weekend.includes(dow) && !cal.holidays.includes(date);
}

export function addBusinessDays(startIso: string, n: number, cal: BusinessCalendar): string {
  let t = Date.parse(startIso);
  let left = n;
  while (left > 0) {
    t += DAY_MS;
    if (isBusinessDay(new Date(t).toISOString(), cal)) left--;
  }
  return new Date(t).toISOString();
}

export function addCalendarDays(startIso: string, n: number, cal: BusinessCalendar, excludeHolidays: boolean): string {
  let t = Date.parse(startIso);
  let left = n;
  while (left > 0) {
    t += DAY_MS;
    if (excludeHolidays && cal.holidays.includes(localDay(t).date)) continue;
    left--;
  }
  return new Date(t).toISOString();
}

export type SlaStatus = 'ON_TRACK' | 'AT_RISK' | 'BREACHED';

/** AT_RISK once 80% of the window has elapsed. */
export function slaStatus(startIso: string, dueIso: string, nowIso: string): SlaStatus {
  const s = Date.parse(startIso);
  const d = Date.parse(dueIso);
  const n = Date.parse(nowIso);
  if (n > d) return 'BREACHED';
  return (n - s) / (d - s) >= 0.8 ? 'AT_RISK' : 'ON_TRACK';
}

export interface SlaReport {
  state: string;
  startedAt: string;
  dueAt: string;
  status: SlaStatus;
  escalateToRole: string;
}

export function slaForCase(
  def: CaseTypeDefinition,
  c: CaseState,
  cal: BusinessCalendar,
  nowIso: string,
): SlaReport | null {
  const policy = def.slaPolicies.find((p) => p.state === c.state);
  if (!policy) return null;
  const dueAt = addBusinessDays(c.stateEnteredAt, policy.businessDays, cal);
  return {
    state: c.state,
    startedAt: c.stateEnteredAt,
    dueAt,
    status: slaStatus(c.stateEnteredAt, dueAt, nowIso),
    escalateToRole: policy.escalateToRole,
  };
}

export interface ClockReport {
  key: string;
  label: LocalizedText;
  legalBasis: string;
  status: 'NOT_STARTED' | 'AWAITING_COUNSEL_CONFIRMATION' | 'RUNNING' | 'EXPIRED';
  startedAt?: string;
  dueAt?: string;
}

/**
 * Statutory clocks start on the LATEST artifact of the named type. A clock whose period counsel
 * hasn't confirmed reports AWAITING_COUNSEL_CONFIRMATION and never produces a due date.
 */
export function statutoryClocks(
  def: CaseTypeDefinition,
  c: CaseState,
  cal: BusinessCalendar,
  nowIso: string,
): ClockReport[] {
  return def.statutoryClocks.map((clock) => {
    const starts = c.artifacts
      .filter((a) => a.type === clock.startsOnArtifact)
      .map((a) => a.createdAt)
      .sort();
    const startedAt = starts[starts.length - 1];
    const common = { key: clock.key, label: clock.label, legalBasis: clock.legalBasis };
    if (!startedAt) return { ...common, status: 'NOT_STARTED' as const };
    if (clock.status === 'AWAITING_COUNSEL_CONFIRMATION' || clock.days === null) {
      return { ...common, status: 'AWAITING_COUNSEL_CONFIRMATION' as const, startedAt };
    }
    const dueAt =
      clock.counting === 'BUSINESS'
        ? addBusinessDays(startedAt, clock.days, cal)
        : addCalendarDays(startedAt, clock.days, cal, clock.excludeOfficialHolidays);
    return {
      ...common,
      status: Date.parse(nowIso) > Date.parse(dueAt) ? ('EXPIRED' as const) : ('RUNNING' as const),
      startedAt,
      dueAt,
    };
  });
}
