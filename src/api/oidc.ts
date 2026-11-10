import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { CASE_TYPES } from '../case-types';
import type { Principal } from './auth';

export interface OidcConfig {
  /** Exact issuer, e.g. https://id.example.sa/realms/cms. Must be https outside local development. */
  issuer: string;
  /** Required `aud` value: tokens minted for other APIs are rejected. */
  audience: string;
  /** Only tokens issued to these clients (`azp`) are accepted. */
  allowedClients: string[];
  /** Tests inject a key resolver; production uses the issuer's JWKS endpoint. */
  jwks?: JWTVerifyGetKey;
  allowInsecureIssuer?: boolean;
  clockToleranceSec?: number;
}

const DEPARTMENTS = ['HR', 'SECURITY', 'AUDIT', 'LEGAL'] as const;
const CLEARANCES = ['STANDARD', 'RESTRICTED', 'PRIVILEGED'] as const;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/**
 * Every role the platform understands. Roles in a token that are not on this list are ignored.
 * The seed set holds the roles that grant permissions directly (see engine/permissions.ts) rather
 * than appearing in a transition guard; the loop below adds every role a case type names.
 * A role used by canAccess but missing here would be silently stripped from every token, so the
 * capability would exist in dev mode and quietly not exist in production.
 */
export function knownRoles(): Set<string> {
  const r = new Set<string>([
    'tenant_admin', 'ethics_officer', 'legal_counsel', 'general_counsel', 'legal_content_editor', 'legal_verifier', 'records_officer',
    'audit_assurance', // read-across: non-privileged cases in other departments, always redacted
    'case_manager', // export
  ]);
  for (const d of Object.values(CASE_TYPES)) {
    for (const t of d.transitions) for (const g of t.guards) {
      if (g.kind === 'role') g.anyOf.forEach((x) => r.add(x));
      if (g.kind === 'approval') r.add(g.approverRole);
    }
    for (const s of d.slaPolicies) if (s.escalateToRole) r.add(s.escalateToRole);
    Object.values(d.sealedFieldRoles).flat().forEach((x) => r.add(x));
  }
  return r;
}
const KNOWN = knownRoles();

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const first = (v: unknown): string | undefined => strArr(v)[0];

/**
 * Identity comes only from verified claims. Tenant, departments, roles and clearance are set by the identity
 * provider's administrators, never by the user or the request.
 */
export function principalFromClaims(c: JWTPayload & Record<string, any>): Principal | undefined {
  const tenantId = first(c.tenant_id);
  if (!c.sub || !tenantId || !TENANT.test(tenantId)) return undefined;
  const kindClaim = first(c.actor_kind);
  const kind = kindClaim === 'external' ? 'external' : 'human'; // AI and system actors can never be minted from a user token
  const clearance = (CLEARANCES as readonly string[]).includes(first(c.clearance) ?? '') ? (first(c.clearance) as Principal['clearance']) : 'STANDARD';
  const matters = strArr(c.counsel_matter_ids);
  return {
    id: c.sub,
    name: first(c.name) ?? first(c.preferred_username) ?? c.sub,
    kind,
    tenantId,
    departments: strArr(c.departments).filter((d): d is (typeof DEPARTMENTS)[number] => (DEPARTMENTS as readonly string[]).includes(d)),
    roles: strArr(c.realm_access?.roles).filter((r) => KNOWN.has(r)),
    reportsTo: strArr(c.reports_to),
    clearance,
    ...(kind === 'external' ? { counselMatterIds: matters } : {}),
  };
}

export class OidcAuthenticator {
  private keys: JWTVerifyGetKey;
  constructor(private cfg: OidcConfig) {
    const u = new URL(cfg.issuer);
    if (u.protocol !== 'https:' && !cfg.allowInsecureIssuer) throw new Error('OIDC issuer must use https');
    this.keys = cfg.jwks ?? createRemoteJWKSet(new URL(`${cfg.issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  }

  async resolve(header: string | undefined): Promise<Principal | undefined> {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
    if (!m) return undefined;
    try {
      const { payload } = await jwtVerify(m[1]!, this.keys, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        algorithms: ['RS256', 'PS256', 'ES256'], // never 'none' or a shared-secret algorithm
        clockTolerance: this.cfg.clockToleranceSec ?? 10,
        requiredClaims: ['exp', 'sub'],
      });
      // Access tokens only: refresh and ID tokens carry a different `typ`.
      if (payload.typ !== undefined && payload.typ !== 'Bearer') return undefined;
      if (typeof payload.azp !== 'string' || !this.cfg.allowedClients.includes(payload.azp)) return undefined;
      return principalFromClaims(payload as JWTPayload & Record<string, unknown>);
    } catch {
      return undefined; // any verification failure is simply "not authenticated"
    }
  }
}
