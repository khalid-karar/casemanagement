# Known gaps and decisions pending

Read this before testing. Anything here is **already known**: report it only if you can show it is worse than described. Nothing here should be read as "accepted risk" unless it says so; most items are waiting for a decision or for work that is not built yet.

Evidence labels: **Verified** = reproduced by running the code. **Code review** = read in the source, not yet exercised: please confirm and report the result either way.

## A. Fixed while preparing this pack: please re-test

Each has an automated test (`test/qa-matrix.test.ts`, `test/roles.test.ts`, `test/hardening.test.ts`) that was checked by deliberately breaking the code and confirming the test fails. Re-prove each by hand and through real sign-in.

| # | What was wrong | Now |
|---|---|---|
| F1 | **Sealed reporter identity leaked through write responses.** `GET` redacted it, but `PATCH fields`, `POST …/transitions/:action`, `…/artifacts`, `…/actions`, `…/assignee`, `…/approvals`, `…/legal-hold` and `POST /cases` returned the stored case unredacted. | Every route that returns a case goes through one redaction function. **Re-test every write route as `a-hr-mgr`, `a-sec-mgr`, `a-assurance`, `a-low`.** |
| F2 | **Two roles stripped from every real token.** `audit_assurance` and `case_manager` worked in dev mode and silently did not exist under Keycloak. | Added; a test reads `permissions.ts` so a new role cannot be forgotten. |
| F3 (was S1) | **No rate limiting, no body-size limit.** | Per-account limit: 300 requests/min, and 20/min on AI and law-upload routes (`429` with `Retry-After`). JSON bodies over 1 MB get `413`; law uploads are capped at 26 MB. The limiter is keyed on the verified account, not on any header. It is per server instance and in memory; **IP-level limits, bot protection and volumetric DoS belong at the gateway/WAF**, and login brute force at Keycloak. |
| F4 (was S2) | **Field edits were not validated and not locked.** Any key, any value, in any state. | Only fields the case type defines, with the right type, enum option, date (`YYYY-MM-DD`, real calendar date) and length; unknown fields and the `[REDACTED]` marker are rejected (`400`, with the offending fields named). **Nothing is editable once a case is CLOSED or ARCHIVED** (`409 FIELD_LOCKED`). In HR, `outcome`, `penaltyType` and `decisionRationale` freeze when the case is DECIDED. The same validation applies when a case is created. Other case types freeze only at close; counsel/owners should say which further fields should freeze earlier. |
| F5 (was S3) | **Audit recorded only which fields changed.** | Records old and new value. **Personal and sealed fields are recorded as SHA-256 only**, so the audit log is not a second copy of a secret. Unchanged values produce no entry. |
| F6 (was S4) | **Blind overwrite of a sealed field.** | A sealed field is **write-once** for everyone without its sealed role: intake may record the reporter, nobody else can replace it (`403 SEALED_FIELD_WRITE`); `ethics_officer` can. |
| F7 (was S10) | `/health` disclosed OCR and paid-OCR configuration. | `/health` returns only `{"ok":true}`. Details are at `/health/details`, for the platform tenant only. |
| F8 (was S11) | CSP allowed `style-src 'unsafe-inline'`. | The UI no longer uses inline styles; `style-src 'self'`. |
| F9 (was S12) | Client-chosen ids were not validated. | Case, artifact and action ids: 1–64 characters, `A–Z a–z 0–9 . _ : -`, starting alphanumeric (`400 INVALID_ID`). |

## B. Still open, with the decision taken

| # | Gap | Evidence | Decision |
|---|---|---|---|
| S5 | **Department and privilege walls are enforced in application code, not by the database.** Row-level security isolates **tenants** only; the app filters the rest. | Verified in `0001_init.sql`, `pg-repo.ts` | **Add database-level department and clearance policies** (`app.departments`, `app.clearance` set per transaction, and filter the list in SQL, which also fixes list performance). Deliberately **not** done blind: it must be built and proven against a real PostgreSQL, which the build environment does not have. Until then the single redaction/permission choke point and the wall tests are the control. |
| S6 | **The audit hash chain is not anchored outside the database.** The app role cannot change rows, but whoever owns the database could rewrite a whole chain consistently. | By design | **Anchor each tenant's chain head daily to write-once storage** (Oracle Object Storage with a retention lock) and verify it in a scheduled job. Built with the operations work (needs the cloud account). |
| S7 | **Token revocation takes up to 5 minutes.** No introspection or back-channel logout. | `docs/KEYCLOAK.md` | **Accepted for the pilot**; add Keycloak back-channel logout and a short denylist before general release. We have not yet checked how the UI behaves when the 5-minute token expires mid-session: please record it. |
| S8 | **No application-level encryption; no key management.** Case data is plain `jsonb`. | `docs/DB-SETUP.md` | **Two layers:** (1) encrypted volumes and database storage with customer-managed keys in the cloud key vault; (2) application-level envelope encryption (AES-256-GCM, a data key per tenant wrapped by the vault key) for sealed and personal fields and for stored law/evidence files. Next build item: it changes the storage and redaction paths and needs its own tests. |
| S9 | **Backups, point-in-time recovery and retention/purge are not built.** `retentionYears` is null, so purge is disabled. | `docs/DB-SETUP.md` | **Continuous WAL archiving plus base backups to in-Kingdom object storage, encrypted, with a restore drill every quarter; purge stays off until counsel sets retention periods.** Operations build. |
| S13 | Access token is held in browser memory; a reload re-authenticates through the Keycloak session. | `docs/KEYCLOAK.md` | Keep (best practice for a public client); check it does not appear in logs, referrers or console. |
| S14 | Realm roles are set by platform staff. Per-tenant role administration by client admins is not built. | `docs/KEYCLOAK.md` | Intentional for the pilot; build a tenant-admin role screen before onboarding a second large client. |

## C. Intentionally incomplete: do not report as defects

- **Statutory clocks have no day counts** (`days: null`, status `AWAITING_COUNSEL_CONFIRMATION`) and every case type is `DRAFT_PENDING_COUNSEL`, until Saudi counsel signs off `docs/COUNSEL-CONFIRMATIONS.md` (Labour Law Art. 72 periods as amended by M/44, Art. 66 penalty ceilings, Art. 71 oral-questioning scope, settlement prerequisite, appeal windows, retention periods). The engine will not assert law that counsel has not confirmed. **Counsel's answers will change workflow rules, so functional tests of Art. 66, Art. 72 and retention are provisional.**
- **Not built yet:** Najiz integration, Nafath sign-in, a job queue (law-text extraction runs in the web process in the background), AI evaluation tasks (`pnpm eval:ai` is a stub), per-tenant role administration.
- **The seeded law text is placeholder wording** marked `[نص تجريبي للاختبار فقط]`, not the gazetted text. Testing against real laws is an open item and is part of this pack (QA-TEST-PLAN §D).
- **The QA realm and `docker-compose.qa.yml` were generated and checked for structure, but not booted in the build environment.** Expect to fix a setup detail on first boot (hostname, TLS, redirect URI) and tell us what it was.
- AI output is always a draft and is never legal advice; that banner is intended.
