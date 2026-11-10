# Known gaps and decisions pending

Read this before testing. Anything here is **already known**: report it only if you can show it is worse than described. Nothing here should be read as "accepted risk" unless it says so; most items are waiting for a decision or for work that is not built yet.

Evidence labels: **Verified** = reproduced by running the code. **Code review** = read in the source, not yet exercised: please confirm and report the result either way.

## A. Fixed while preparing this pack — please re-test

| # | What was wrong | Status |
|---|---|---|
| F1 | **Sealed reporter identity leaked through write responses.** `GET` redacted it correctly, but `PATCH /cases/:id/fields`, `POST …/transitions/:action`, `…/artifacts`, `…/actions`, `…/assignee`, `…/approvals`, `…/legal-hold` and `POST /cases` returned the stored case unredacted. Any HR manager could read the whistleblower's identity from a no-op edit. | **Fixed and verified.** Every route that returns a case now goes through one redaction function. Regression test: `test/qa-matrix.test.ts` ("sealed identity is not readable back from any write route"). **Re-test every write route as `a-hr-mgr`, `a-sec-mgr`, `a-assurance`, `a-low`.** |
| F2 | **Two roles stripped from every real token.** `audit_assurance` (read-across) and `case_manager` (export) are used by the permission model but were missing from the token role filter, so they worked in dev mode and silently did not exist under Keycloak. | **Fixed and verified** (`test/roles.test.ts`). The test now reads `permissions.ts`, so a new role cannot be forgotten. |

## B. Security gaps, not fixed (need a decision or are not built)

| # | Gap | Evidence | Why it matters |
|---|---|---|---|
| S1 | **No rate limiting and no JSON body-size limit** on any endpoint (only the 25 MB file cap). | Verified by search: none present | Brute force is limited only by Keycloak's lockout; API abuse and memory exhaustion are open. Expect this finding; we plan a gateway/WAF layer on Oracle Cloud. |
| S2 | **Field edits are not validated and not state-locked.** `setFields` accepts any keys, ignores enum options and types, and has no check on case state, so a CLOSED or ARCHIVED case's `outcome` or `penaltyType` can be rewritten. | Code review (`src/engine/workflow.ts`, `setFields`) | Integrity of decided cases. The fix is a product decision (which fields lock at which state), so it is not changed here. |
| S3 | **The audit log records which fields changed, not their old and new values.** | Verified: payload is `{"fields":["severity"]}` | A tampered or mistaken edit cannot be reconstructed from the log. |
| S4 | **Blind overwrite of a sealed field.** A user who cannot read `reporterIdentity` can still `PATCH` it. | Code review | Replaces the reporter's identity without being able to see it. Likely rule: sealed fields writable only by their sealed-field roles. |
| S5 | **Department and privilege walls are enforced in application code, not by the database.** Postgres row-level security isolates **tenants** only. `listCases` loads every case of the tenant and the app filters. | Verified in `0001_init.sql` and `pg-repo.ts` | An application bug (like F1) is the only barrier between departments. This is why the wall tests matter. |
| S6 | **The audit hash chain is not anchored outside the database.** The app role cannot update or delete rows, but whoever owns the database could rewrite a whole chain consistently. | By design; no external anchor built | Detects accidental and partial tampering, not a privileged insider. |
| S7 | **Token revocation takes up to 5 minutes.** No introspection or back-channel logout. | Documented in `docs/KEYCLOAK.md` | A disabled user keeps access until the access token expires. |
| S8 | **No encryption of sensitive fields in the application; no key management.** Case data is plain `jsonb`. Relies on volume encryption in the Kingdom. | Documented in `docs/DB-SETUP.md` | Open item (encryption). A database dump is readable. |
| S9 | **Backups, point-in-time recovery and retention/purge are not built.** `retentionYears` is null, so purge is disabled. | Documented | Open item (backups). Cannot be tested yet. |
| S10 | `/health` and `/auth/config` are unauthenticated. `/health` reports whether OCR and the paid OCR engine are configured. | Verified | Minor information disclosure. |
| S11 | `style-src 'unsafe-inline'` in the Content-Security-Policy (the UI uses inline `style`). `script-src` is `'self'`. | Verified in headers | Weakens CSP against style injection. |
| S12 | Case, artifact and action ids are chosen by the client; format and length are not validated. | Code review | The web UI escapes them. Test stored XSS and oversized ids anyway. |
| S13 | Access token is held in browser memory; a reload re-authenticates through the Keycloak session. | Documented | Check for token exposure in logs, referrers and console. |
| S14 | Realm roles are set by platform staff in Keycloak. Per-tenant role administration by client admins is not built. | Documented | A tenant admin cannot grant roles, by design for now. |

## C. Intentionally incomplete: do not report as defects

- **Statutory clocks have no day counts** (`days: null`, status `AWAITING_COUNSEL_CONFIRMATION`) and every case type is `DRAFT_PENDING_COUNSEL`, until Saudi counsel signs off `docs/COUNSEL-CONFIRMATIONS.md` (Labour Law Art. 72 periods as amended by M/44, Art. 66 penalty ceilings, Art. 71 oral-questioning scope, settlement prerequisite, appeal windows, retention periods). The engine will not assert law that counsel has not confirmed. **Counsel's answers will change workflow rules, so functional tests of Art. 66, Art. 72 and retention are provisional.**
- **Not built yet:** Najiz integration, Nafath sign-in, a job queue (law-text extraction runs in the web process in the background), AI evaluation tasks (`pnpm eval:ai` is a stub), per-tenant role administration.
- **The seeded law text is placeholder wording** marked `[نص تجريبي للاختبار فقط]`, not the gazetted text. Testing against real laws is an open item and is part of this pack (QA-TEST-PLAN §D).
- **The QA realm and `docker-compose.qa.yml` were generated and checked for structure, but not booted in the build environment.** Expect to fix a setup detail on first boot (hostname, TLS, redirect URI) and tell us what it was.
- AI output is always a draft and is never legal advice; that banner is intended.
