# Case management platform

Multi-tenant, Arabic-first case management for Saudi corporates: HR, Security, Audit and Legal (court escalation), with an in-Kingdom AI assistant.

- `src/engine` – case types as data, guarded workflow, hash-chained audit, evidence custody, ABAC, referral, legal hold, Saudi SLA calendar
- `src/case-types` – HR, Security, Audit, Legal packs
- `src/ai` – model-agnostic provider, permission-filtered retrieval, draft-only assistant
- `src/api` – Hono API, in-memory and PostgreSQL repositories
- `src/legal` – law library: versions, effective dating, AI proposals, human verification, file text extraction
- `src/db` – SQL migrations (RLS, append-only audit) and migration runner; see `docs/DB-SETUP.md`
- `web/` – Arabic-first bilingual UI
- `docs/` – model decision, counsel confirmations
- `docs/handoff/` – QA and penetration-test pack for the Saudi team (start at its README)

`pnpm install && pnpm typecheck && pnpm test`

Najiz filing is built and tested against a simulator (`docs/NAJIZ.md`); the real Najiz wire mapping waits for a client's portal access. Not yet built: Nafath sign-in, job queue, eval tasks (`pnpm eval:ai` has no tasks yet), encryption of sensitive fields, backups and retention. See `docs/handoff/KNOWN-GAPS.md`.

## Test data
`pnpm seed` loads QA cases and a verified law into a running server. The 22 test accounts live in `src/api/test-users.ts` and drive both the dev user switcher and the QA Keycloak realm (`pnpm gen:realm:qa`). Test data only.

## Sign-in
Run locally with `pnpm start:dev` (demo user switcher, `AUTH_MODE=dev`). Real deployments use Keycloak (`AUTH_MODE=oidc`); see docs/KEYCLOAK.md. The server refuses to start without an explicit mode, and refuses dev mode in production.
