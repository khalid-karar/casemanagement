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

`pnpm install && pnpm typecheck && pnpm test`

Not yet built: identity (Keycloak/Nafath), Najiz integration, job queue, eval tasks (`pnpm eval:ai` has no tasks yet).

## Sign-in
Run locally with `pnpm start:dev` (demo user switcher, `AUTH_MODE=dev`). Real deployments use Keycloak (`AUTH_MODE=oidc`); see docs/KEYCLOAK.md. The server refuses to start without an explicit mode, and refuses dev mode in production.
