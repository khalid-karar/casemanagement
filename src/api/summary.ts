import { canAccess, evaluateTransition, redactForActor, REDACTED } from '../engine';
import type { CaseState, CaseTypeDefinition } from '../engine';
import type { Principal } from './auth';

/**
 * What lists and the dashboard may say about a case. Built ONLY from the redacted view, from NORMAL-sensitivity fields,
 * so a sealed or personal value can never reach a list, a search index or a count. Sorting and searching run on these
 * summaries, never on raw fields.
 */
const TITLE_KEYS = ['title', 'allegationSummary', 'narrative'];
export interface CaseSummary {
  id: string; caseTypeKey: string; department: string; state: string; stateKind: string; title: string | null; confidentiality: string;
  assigneeId: string | null; createdAt: string; stateEnteredAt: string; ageDays: number; legalHold: boolean;
  openActions: number; overdueActions: number; nextDue: string | null;
}

export function summarise(cs: CaseState, user: Principal, def: CaseTypeDefinition, nowIso: string): CaseSummary {
  const v = redactForActor(def, cs, user);
  const key = TITLE_KEYS.find((k) => def.fields.some((f) => f.key === k && f.sensitivity === 'NORMAL'));
  const raw = key ? v.fields[key] : undefined;
  const title = typeof raw === 'string' && raw !== REDACTED && raw ? (raw.length > 90 ? raw.slice(0, 90) + '…' : raw) : null;
  const now = Date.parse(nowIso);
  const open = v.actions.filter((a) => a.status === 'OPEN');
  const due = open.filter((a) => a.dueDate).map((a) => a.dueDate!).sort();
  return {
    id: v.id, caseTypeKey: v.caseTypeKey, department: v.department, state: v.state,
    stateKind: def.states.find((s) => s.key === v.state)?.kind ?? 'OPEN', title, confidentiality: v.confidentiality,
    assigneeId: v.assignee?.id ?? null, createdAt: v.createdAt, stateEnteredAt: v.stateEnteredAt,
    ageDays: Math.max(0, Math.floor((now - Date.parse(v.createdAt)) / 86400000)), legalHold: Boolean(v.legalHold),
    openActions: open.length, overdueActions: open.filter((a) => a.dueDate && Date.parse(a.dueDate) < now).length, nextDue: due[0] ?? null,
  };
}

export interface SearchQuery { q?: string; state?: string; dept?: string; type?: string; mine?: boolean; open?: boolean; overdue?: boolean; due?: number; needsAction?: boolean; sort?: string; order?: 'asc' | 'desc'; page?: number; pageSize?: number }
export type Row = CaseSummary & { needsMe?: string[] };

const SORTS: Record<string, (a: Row) => string | number> = {
  id: (r) => r.id, state: (r) => r.state, dept: (r) => r.department, age: (r) => r.ageDays, updated: (r) => r.stateEnteredAt, created: (r) => r.createdAt, title: (r) => r.title ?? '', due: (r) => r.nextDue ?? '9999',
};

/** Why a case is waiting on this person: assigned to them, or a step is ready for them, or an approval is theirs to give. */
export function needsMe(cs: CaseState, user: Principal, def: CaseTypeDefinition): string[] {
  const kind = def.states.find((s) => s.key === cs.state)?.kind ?? 'OPEN';
  if (kind !== 'OPEN') return [];
  const why: string[] = [];
  if (cs.assignee?.id === user.id) why.push('ASSIGNED');
  if (canAccess(user, cs, 'transition').allowed) {
    for (const t of def.transitions.filter((x) => x.from.includes(cs.state))) {
      const ev = evaluateTransition(def, cs, t.action, user);
      if (ev.allowed) { why.push('READY'); break; }
    }
    for (const t of def.transitions.filter((x) => x.from.includes(cs.state))) {
      const ev = evaluateTransition(def, cs, t.action, user);
      const need = ev.blockers.map((b) => /^APPROVAL_REQUIRED:(.+)$/.exec(b.code)?.[1]).filter((r): r is string => Boolean(r));
      if (need.some((r) => user.roles.includes(r)) && !cs.approvals.some((a) => a.approverId === user.id)) { why.push('APPROVAL'); break; }
    }
  }
  return [...new Set(why)];
}

export function search(cases: CaseState[], user: Principal, defs: Record<string, CaseTypeDefinition>, nowIso: string, q: SearchQuery) {
  let rows: Row[] = cases.filter((c) => canAccess(user, c, 'read').allowed && defs[c.caseTypeKey]).map((c) => {
    const r: Row = summarise(c, user, defs[c.caseTypeKey]!, nowIso);
    if (q.needsAction) r.needsMe = needsMe(c, user, defs[c.caseTypeKey]!);
    return r;
  });
  const needle = (q.q ?? '').trim().toLowerCase();
  if (needle) rows = rows.filter((r) => r.id.toLowerCase().includes(needle) || (r.title ?? '').toLowerCase().includes(needle));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  if (q.dept) rows = rows.filter((r) => r.department === q.dept);
  if (q.type) rows = rows.filter((r) => r.caseTypeKey === q.type);
  if (q.mine) rows = rows.filter((r) => r.assigneeId === user.id);
  if (q.open) rows = rows.filter((r) => r.stateKind === 'OPEN');
  if (q.overdue) rows = rows.filter((r) => r.overdueActions > 0);
  if (q.due) rows = rows.filter((r) => r.nextDue !== null && Math.floor((Date.parse(r.nextDue) - Date.parse(nowIso)) / 86400000) <= q.due!);
  if (q.needsAction) rows = rows.filter((r) => (r.needsMe ?? []).length > 0);
  const key = SORTS[q.sort ?? 'updated'] ?? SORTS['updated']!;
  const dir = q.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.id.localeCompare(b.id); });
  const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
  const page = Math.max(1, q.page ?? 1);
  return { total: rows.length, page, pageSize, items: rows.slice((page - 1) * pageSize, page * pageSize) };
}

export function dashboard(cases: CaseState[], user: Principal, defs: Record<string, CaseTypeDefinition>, nowIso: string) {
  const mine = cases.filter((c) => canAccess(user, c, 'read').allowed && defs[c.caseTypeKey]);
  const rows = mine.map((c) => ({ c, s: summarise(c, user, defs[c.caseTypeKey]!, nowIso) }));
  const open = rows.filter((r) => r.s.stateKind === 'OPEN');
  const tally = (f: (r: (typeof rows)[number]) => string) => { const m: Record<string, number> = {}; for (const r of open) m[f(r)] = (m[f(r)] ?? 0) + 1; return Object.entries(m).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };
  const queue = open.map((r) => ({ r, why: needsMe(r.c, user, defs[r.c.caseTypeKey]!) })).filter((x) => x.why.length)
    .sort((a, b) => b.r.s.ageDays - a.r.s.ageDays).slice(0, 12).map((x) => ({ ...x.r.s, why: x.why }));
  const actions: { caseId: string; caseTitle: string | null; actionId: string; description: string; ownerId: string | null; dueDate: string; overdue: boolean }[] = [];
  for (const { c, s } of open) for (const a of c.actions) {
    if (a.status !== 'OPEN' || !a.dueDate) continue;
    const days = Math.floor((Date.parse(a.dueDate) - Date.parse(nowIso)) / 86400000);
    if (days <= 7) actions.push({ caseId: c.id, caseTitle: s.title, actionId: a.id, description: a.description, ownerId: a.ownerId ?? null, dueDate: a.dueDate, overdue: days < 0 });
  }
  actions.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    counts: { open: open.length, closed: rows.length - open.length, onHold: open.filter((r) => r.s.legalHold).length, needsMe: queue.length, overdue: actions.filter((a) => a.overdue).length, dueSoon: actions.filter((a) => !a.overdue).length },
    byState: tally((r) => `${r.s.caseTypeKey}|${r.s.state}`).map((x) => { const [caseTypeKey, state] = x.key.split('|'); return { caseTypeKey, state, count: x.count }; }),
    byDept: tally((r) => r.s.department),
    queue, actions: actions.slice(0, 15),
    recent: [...rows].sort((a, b) => b.s.stateEnteredAt.localeCompare(a.s.stateEnteredAt)).slice(0, 6).map((r) => r.s),
  };
}
