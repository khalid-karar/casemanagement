# Case management platform

Multi-tenant, Arabic-first case management for Saudi corporates: HR, Security, Audit and Legal (court escalation), with an in-Kingdom AI assistant.

- `src/engine` – case types as data, guarded workflow, hash-chained audit, evidence custody, ABAC, referral, legal hold, Saudi SLA calendar
- `src/case-types` – HR, Security, Audit, Legal packs
- `src/ai` – model-agnostic provider, permission-filtered retrieval, draft-only assistant
- `src/db` – Drizzle schema and RLS migration (not yet run on live Postgres)
- `docs/` – model decision, counsel confirmations

`pnpm install && pnpm typecheck && pnpm test`

Not yet built: API/UI (Next.js), identity (Keycloak/Nafath), Najiz integration, job queue, eval tasks (`pnpm eval:ai` has no tasks yet).
