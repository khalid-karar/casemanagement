# Sign-in with Keycloak

The API no longer trusts any user header in production. Every request carries a Keycloak access token (JWT); the API verifies it and builds the user from the token's claims.

## Two realm files
`deploy/keycloak/cms-realm.json` is the production realm: no users, TOTP enrolment forced, no password grant. `cms-realm-qa.json` (`pnpm gen:realm:qa`) is for the QA environment only: 22 test users from `src/api/test-users.ts`, TOTP not forced, and a `case-qa` client with password grant (the API must list it in `OIDC_ALLOWED_CLIENTS`; see `deploy/docker-compose.qa.yml`). Never import the QA realm into a real environment.

## What is checked on every request
RS256/PS256/ES256 signature against the realm's JWKS (cached, rotated automatically); `iss` equals `OIDC_ISSUER`; `aud` contains `case-api`; `exp`/`nbf`; token type is an access token; `azp` is an allowed client (`case-web`). `alg=none` and shared-secret algorithms are rejected. Any failure is a plain 401.

## Where identity comes from (admin-controlled, never the user)
| Token claim | Becomes | Notes |
|---|---|---|
| `sub`, `name` | user id, display name | |
| `tenant_id` | tenant | Required, `^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$`. `platform` = our own staff. Tenant is never read from the request. |
| `realm_access.roles` | roles | Filtered to the platform's known roles; anything else is ignored |
| `departments` | HR / SECURITY / AUDIT / LEGAL | |
| `clearance` | STANDARD / RESTRICTED / PRIVILEGED | default STANDARD |
| `reports_to`, `actor_kind`, `counsel_matter_ids` | line manager, human/external, outside-counsel matters | `actor_kind` can never produce an AI/system actor |

These attributes are defined in the realm's user profile as **admin-only** (users cannot view or edit them).

## Setup
1. `pnpm exec tsx scripts/gen-realm.mts deploy/keycloak/cms-realm.json` regenerates the realm from the code's role list (re-run after adding a role). It is committed.
2. Edit the redirect URI in the realm (`CHANGE-ME.example.sa`) and start with `deploy/docker-compose.yml`, or import the realm into your Keycloak.
3. App env: `AUTH_MODE=oidc`, `OIDC_ISSUER=https://<host>/realms/cms`, optional `OIDC_CLIENT_ID` (default `case-web`), `OIDC_AUDIENCE` (default `case-api`), `OIDC_ALLOWED_CLIENTS`.
4. `AUTH_MODE=dev` (the user switcher) is refused when `NODE_ENV=production`; the server will not start without an explicit mode.
5. Create each client organisation's users with `tenant_id` set to that tenant. Onboard Nafath later as an identity provider in the same realm (no API change).

Realm hardening included: mandatory TOTP for all users, brute-force lockout, 12-char password policy with history, 5-minute access tokens, refresh-token rotation, event + admin-event logging, no self-registration, no direct password grants, PKCE S256 only.

## Verified
Unit tests with a generated key (valid, wrong issuer/audience/signature/client, expired, `alg=none`, bad tenant, unknown roles, AI actor attempt). Also run for real against Keycloak 26.0.8 with Playwright: PKCE login → token → API → correct tenant, roles and tabs for a client user and a platform user; logout returns to the login page; a garbage token and a dev token both get 401 in oidc mode.

## Known limits (for the QA / pentest team)
- Revocation relies on the 5-minute token life; there is no introspection or back-channel logout yet.
- The access token is held in browser memory (not storage); a reload silently re-authenticates via the Keycloak session. A strict CSP is set (`script-src 'self'`); the UI still uses inline `style` attributes.
- The realm file ships with a placeholder redirect URI and Keycloak's `start-dev` is not for production (use `start` behind TLS).
- Roles are realm roles; per-tenant role administration by client admins is not built (platform staff set them in Keycloak).
