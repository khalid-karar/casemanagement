import type { Actor } from '../engine';

export interface Principal extends Actor {
  name: string;
  /** Legal-library roles live alongside case roles. */
}

/**
 * DEV AUTH ONLY. `Authorization: Bearer dev:<userId>` resolves against a user directory.
 * Production replaces this with Keycloak (OIDC) JWT verification + Nafath; the rest of the API
 * only ever sees a Principal, so nothing else changes. QA must treat this as a known gap.
 */
export class Directory {
  private users = new Map<string, Principal>();
  add(p: Principal) { this.users.set(p.id, p); }
  resolve(header: string | undefined): Principal | undefined {
    const m = /^Bearer dev:(.+)$/.exec(header ?? '');
    return m ? this.users.get(m[1]!) : undefined;
  }
}
