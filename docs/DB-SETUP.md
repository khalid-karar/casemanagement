# Database setup (PostgreSQL 14+; tested on 16)

Two roles, on purpose:

| Role | Used for | Rights |
|------|----------|--------|
| owner (e.g. `cms_owner`) | running migrations only | owns tables |
| `cms_app` | the running application | SELECT/INSERT/UPDATE (audit tables: SELECT/INSERT only). **No ownership, no BYPASSRLS, not superuser.** |

```sql
CREATE ROLE cms_app LOGIN PASSWORD '<secret>';
-- as owner, create the database, then:
```
```bash
MIGRATE_DATABASE_URL=postgres://cms_owner:…@host/cms pnpm migrate
DATABASE_URL=postgres://cms_app:…@host/cms pnpm start
```

The server **refuses to start** if `DATABASE_URL` connects as a superuser or a role with BYPASSRLS, because that would silently turn off tenant isolation.

## What the database enforces by itself
- Row-level security on every tenant table, keyed on `app.tenant_id`, set per transaction. Unset = no rows (fail-closed).
- `audit_events` and `legal_log` reject UPDATE, DELETE and TRUNCATE (trigger), and the app role has no such grants.
- Clients can read only VERIFIED baseline law. Drafts, AI proposals and original law files are visible only to the platform tenant.
- Only the `platform` tenant can write the national-law baseline.
- Concurrent actions on one case are serialised with a row lock (`SELECT … FOR UPDATE`); legal-library writes with an advisory lock.

## Tests
```bash
TEST_ADMIN_URL=postgres://owner@host/cms_test TEST_APP_URL=postgres://cms_app:…@host/cms_test pnpm test
```
Without these variables the Postgres tests are skipped and the same API suite runs on the in-memory repo. **The test database is wiped on each run: never point it at real data.**

## Known limits (for QA and the pilot)
- Application-level encryption of sensitive fields and key management are not implemented (rely on disk/volume encryption in the Kingdom for now).
- No connection-level TLS configuration or pooler settings are set; configure in the connection string.
- Legal library is loaded per request (fine for hundreds of articles; add caching/indexing before large corpora).
- Backups, point-in-time recovery and retention/purge jobs are operational tasks not yet built.

## Law file upload: OCR requirements
The runtime needs `poppler-utils`, `tesseract-ocr` and `tesseract-ocr-ara` (the `Dockerfile` installs them). `/health` reports `"ocr": true|false`; without them, scans and Arabic PDFs are refused with 503.
Arabic PDFs are always read by OCR, not from the PDF's text layer, because those layers commonly reverse letters or turn "لا" into "ال". OCR output carries a confidence score and is never trusted without human verification against the original file.

## Paid OCR (optional, platform national-law uploads only)
Set `PAID_OCR_API_KEY`, `PAID_OCR_MODEL` and optionally `PAID_OCR_KIND` (`anthropic` or `openai`-compatible) and `PAID_OCR_BASE_URL` (https only). It is used **only** for uploads made by the `platform` tenant (public national law). Uploads under any client tenant always use the in-Kingdom local OCR; this is enforced in code (`routeOcr`) and tested. If the paid engine fails, the system falls back to local OCR and tells the reviewer. Pick the vendor by testing it on real Saudi law scans, and require zero data retention and no training on submitted data in the contract.
