# QA and penetration-test handoff pack

For the Saudi QA and penetration-testing team. Everything here is for **test environments with test data only**.

| Document | Read it for |
|---|---|
| `KNOWN-GAPS.md` | **Read first.** What is already known, what was fixed while preparing this pack, what is intentionally unfinished |
| `QA-TEST-PLAN.md` | Functional, access-wall, Arabic, legal-library, AI and integrity test cases with expected results; defect template and severity |
| `PENTEST-BRIEF.md` | Scope, trust boundaries, attack hypotheses, rules of engagement, reporting |

Other documents in `docs/`: `KEYCLOAK.md` (sign-in), `DB-SETUP.md` (database roles, RLS), `AI-ENGINES.md` (AI engines and consent), `COUNSEL-CONFIRMATIONS.md` (legal points awaiting Saudi counsel), `MODEL-DECISION.md`.

## What we need back
1. QA results per test case (PASS / FAIL / BLOCKED), with evidence.
2. Defects using the template in the test plan.
3. The penetration test report described in the brief.
4. Two open items where **you** produce the evidence we need: Arabic quality with real laws (QA-TEST-PLAN §D7) and Arabic quality of the AI answers (§E11).

## Stand up an environment

**Quick (functional testing, no Keycloak)**: Node 22 and pnpm.
```bash
pnpm install
pnpm start:dev              # in-memory data; user switcher at http://localhost:3000
pnpm seed                   # in a second terminal: test cases and a verified law
```
Add `DATABASE_URL` (role `cms_app`, see `DB-SETUP.md`) to keep data across restarts and to test row-level security. Scans and Arabic PDFs need `poppler-utils`, `tesseract-ocr` and `tesseract-ocr-ara` (the `Dockerfile` has them); `/health/details` (as `p-editor`) shows `"ocr": true` when they are present. `pnpm start:dev` is refused when `NODE_ENV=production`.

**QA realm (real sign-in)**
```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.qa.yml up
SEED_AUTH=oidc OIDC_ISSUER=https://<keycloak>/realms/cms pnpm seed
```
The QA realm (`deploy/keycloak/cms-realm-qa.json`) has the accounts below with password `Qa-Test-Only-Passw0rd!`, no forced TOTP, and a `case-qa` client that allows password grant. Regenerate both realms after any role change with `pnpm gen:realm` and `pnpm gen:realm:qa`. **This stack has been generated and structure-checked but not booted by us**: expect to set the hostname, TLS and redirect URI (`CHANGE-ME.example.sa` in the realm), and tell us what you had to change.

**Production-shaped (penetration test)**: `deploy/docker-compose.yml` with the production realm `cms-realm.json`: no users, TOTP enforced. We create your accounts.

**Automated checks** (run these first; they should all pass): `pnpm typecheck && pnpm test`. The PostgreSQL tests need `TEST_ADMIN_URL` and `TEST_APP_URL` (see `DB-SETUP.md`); they **wipe the database**.

## Test accounts
Defined once in `src/api/test-users.ts`; this table is generated from it. Pairs of accounts differ in one attribute so each wall can be proved cleanly.

| Account | Tenant | Dept | Roles | Clearance | Why it exists |
|---|---|---|---|---|---|
| `a-hr-intake` | tenant-a | HR | hr_intake | RESTRICTED | Opens and triages HR cases; cannot assign or decide. |
| `a-hr-mgr` | tenant-a | HR | hr_manager, hr_intake | RESTRICTED | Main HR path: triage, assign, decide, notify, close. |
| `a-hr-inv` | tenant-a | HR | hr_investigator | RESTRICTED | Investigates; must not be able to decide a penalty. |
| `a-hr-dir` | tenant-a | HR | hr_director | RESTRICTED | Approver for a penalty decision (separation of duties). |
| `a-ethics` | tenant-a | HR | ethics_officer | RESTRICTED | The only account that may see a sealed reporter identity. |
| `a-low` | tenant-a | HR | hr_intake | STANDARD | STANDARD clearance: must be refused RESTRICTED cases in its own department. |
| `a-sec-mgr` | tenant-a | SECURITY | security_manager, security_intake | RESTRICTED | Security path, and the far side of the HR/Security department wall. |
| `a-sec-inv` | tenant-a | SECURITY | security_investigator | RESTRICTED | Investigates security incidents. |
| `a-sec-dir` | tenant-a | SECURITY | security_director | RESTRICTED | Approver required to close a security incident. |
| `a-aud-mgr` | tenant-a | AUDIT | audit_manager, auditor | RESTRICTED | Raises and rates audit findings. |
| `a-aud-dir` | tenant-a | AUDIT | audit_director | RESTRICTED | Closes audit findings; has no route into a legal matter. |
| `a-assurance` | tenant-a | AUDIT | audit_assurance | RESTRICTED | Read-across: may READ other departments, redacted, never PRIVILEGED, never write. |
| `a-counsel` | tenant-a | LEGAL | legal_counsel, general_counsel, case_manager | PRIVILEGED | Legal matters, legal hold, export. Holds general_counsel too, but approval must come from someone else: use a-gc. |
| `a-gc` | tenant-a | LEGAL | general_counsel | PRIVILEGED | Second approver to close a legal matter (a-counsel cannot approve their own closure). |
| `a-records` | tenant-a | HR | records_officer | RESTRICTED | Archives closed cases; must be blocked by a legal hold. |
| `a-admin` | tenant-a | HR | tenant_admin | RESTRICTED | Signs or withdraws the AI consent; reads the AI log. |
| `a-ext-counsel` | tenant-a | LEGAL | (external, matter m-1) | PRIVILEGED | Outside counsel: matter m-1 only, read/write only, no transitions. |
| `b-hr-mgr` | tenant-b | HR | hr_manager, hr_intake | RESTRICTED | Identical rights to a-hr-mgr in another tenant: must see none of tenant-a. |
| `b-counsel` | tenant-b | LEGAL | legal_counsel, general_counsel | PRIVILEGED | Highest clearance in tenant-b: still must see none of tenant-a. |
| `b-admin` | tenant-b | HR | tenant_admin | RESTRICTED | Must not be able to change tenant-a’s AI settings or read its AI log. |
| `p-editor` | platform | LEGAL | legal_content_editor | RESTRICTED | Uploads national law; must not be able to verify their own upload. |
| `p-verifier` | platform | LEGAL | legal_verifier | RESTRICTED | Verifies a version uploaded by someone else (four-eyes). |


Case ids that the seed creates: `HR-2026-001` (new, no severity), `HR-2026-002` (findings issued, awaiting director approval), `HR-2026-003` (sealed anonymous reporter), `SEC-2026-001`, `AUD-2026-001`, matters `m-1` (the only one external counsel may reach) and `m-2`; tenant-b has its own `HR-2026-001` and `m-1`.

## Build identity
Record the commit hash you tested in every report: `git rev-parse HEAD`.
