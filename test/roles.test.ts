import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { knownRoles, principalFromClaims } from '../src/api/oidc';
import { canAccess } from '../src/engine';
import type { Actor } from '../src/engine';

const T = '00000000-0000-0000-0000-000000000001';
const res = (over: Partial<Parameters<typeof canAccess>[1]> = {}) =>
  ({ tenantId: T, department: 'HR' as const, confidentiality: 'RESTRICTED' as const, ...over });
const actor = (roles: string[], over: Partial<Actor> = {}): Actor =>
  ({ id: 'u', kind: 'human', tenantId: T, departments: ['AUDIT'], roles, reportsTo: [], clearance: 'RESTRICTED', ...over });

/**
 * A role that grants a permission in canAccess but is missing from knownRoles() would be stripped
 * from every OIDC token: the capability would work in dev mode and silently not exist in production.
 * This reads permissions.ts so a new role added there cannot be forgotten in the token filter.
 */
describe('roles used by the permission model are mintable from a token', () => {
  it('every role named in permissions.ts is on the known-roles list', () => {
    const src = readFileSync(new URL('../src/engine/permissions.ts', import.meta.url), 'utf8');
    const used = new Set([...src.matchAll(/roles\.includes\('([a-z_]+)'\)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((r) => !knownRoles().has(r));
    expect(missing).toEqual([]);
  });

  it('keeps audit_assurance and case_manager when building a principal from claims', () => {
    const p = principalFromClaims({
      sub: 'u1', tenant_id: T, departments: ['AUDIT'], clearance: 'RESTRICTED',
      realm_access: { roles: ['audit_assurance', 'case_manager', 'not_a_real_role'] },
    } as never);
    expect(p?.roles).toEqual(['audit_assurance', 'case_manager']);
  });
});

describe('read-across and export', () => {
  it('lets audit assurance read another department but never privileged material', () => {
    expect(canAccess(actor(['audit_assurance']), res(), 'read').allowed).toBe(true);
    expect(canAccess(actor(['audit_assurance']), res({ confidentiality: 'PRIVILEGED' }), 'read'))
      .toMatchObject({ allowed: false });
    // Read-across is read-only: it never becomes a write or a transition.
    expect(canAccess(actor(['audit_assurance']), res(), 'write')).toMatchObject({ allowed: false, reason: 'DEPARTMENT_WALL' });
    expect(canAccess(actor([]), res(), 'read')).toMatchObject({ allowed: false, reason: 'DEPARTMENT_WALL' });
  });

  it('restricts export to case_manager and legal_counsel inside their own department', () => {
    const own = { departments: ['HR'] as Actor['departments'] };
    expect(canAccess(actor(['case_manager'], own), res(), 'export').allowed).toBe(true);
    expect(canAccess(actor(['hr_manager'], own), res(), 'export')).toMatchObject({ allowed: false, reason: 'ROLE_REQUIRED:case_manager' });
    // Read-across does not carry export with it.
    expect(canAccess(actor(['audit_assurance', 'case_manager']), res(), 'export')).toMatchObject({ allowed: false, reason: 'DEPARTMENT_WALL' });
  });
});
