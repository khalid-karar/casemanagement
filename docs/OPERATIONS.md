# Operations

## Sign-out and revocation (S7)
Access tokens stay valid until they expire. Revocation closes that gap: a token issued **before** a person was revoked is refused immediately, on every server (shared table, polled every 10 s; `REVOCATION_POLL_MS`).
- **Sign-out:** in the Keycloak client `case-web`, set *Backchannel logout URL* to `https://<host>/auth/backchannel-logout` and *Backchannel logout session required* off. Keycloak posts a signed logout token; we verify issuer, audience, signature and the logout event (a normal token cannot be replayed as one).
- **Leaver / lost device:** a tenant admin calls `POST /admin/revoke-sessions {"subject": "<user id>"}`. Disable the account in Keycloak as well so they cannot sign in again.
- Not yet tested against the real Keycloak: tests use signed tokens that follow the specification.

## Background jobs
In-process scheduler. Each job runs on one server at a time (Postgres advisory lock), never overlaps, logs failures and retries next tick. Jobs are idempotent.
| Job | When | Needs |
|---|---|---|
| `najiz-sync` | every `NAJIZ_SYNC_MINUTES` (15) | `NAJIZ_MODE=live` clients only; records what Najiz reports, never changes case state |
| `audit-anchor` | every `ANCHOR_MINUTES` (60) | `ANCHOR_DIR` |

## Audit anchoring
A hash chain proves a case's trail is internally consistent but not that a whole chain was not rebuilt by someone with database access. `audit-anchor` writes every case's chain head to files **outside the database** (`ANCHOR_DIR`), each anchor chained to the previous one. `ANCHOR_DIR=… DATABASE_URL=… pnpm anchors verify <tenant>` fails if any anchor was edited or removed, a case vanished, or a past event no longer has the anchored hash.
Point `ANCHOR_DIR` at storage the application account cannot rewrite (write-once volume or object storage with retention lock). Any other sink implements `AnchorSink`.

## Backup and restore (S9)
- `scripts/backup.sh` writes an encrypted, checksummed `pg_dump` (needs `DATABASE_ADMIN_URL`, `BACKUP_DIR`, `BACKUP_PASSPHRASE_FILE`). Ship `BACKUP_DIR` to in-Kingdom storage. Keep the backup passphrase and the data master key in different places from the backups.
- `scripts/restore.sh <file> <empty db url>` verifies the checksum, restores, prints row counts. It refuses a non-empty target.
- **Restore drill (quarterly):** restore the latest backup into a scratch database, compare counts with production, start the app against it, run `pnpm anchors verify` for each tenant, open a case with sensitive fields (proves the master key and tenant keys match). Record the date and result.
- Continuous WAL archiving / point-in-time recovery is a database-platform setting for the hosting environment, not application code; enable it there and drill it the same way.
- Rehearsed in the build environment: backup, restore into an empty database, row counts matched, wrong passphrase and non-empty target refused.

## Retention
Purge is **off**. No retention period is configured or enforced until counsel sets one; nothing deletes case data.

## Tenant administration (S14)
Roles are assigned in Keycloak. Tenant admins have a **People & access** screen (`#/people`): everyone who has signed in, their departments and roles, last sign-in, and an *End sessions* button (immediate revocation, own organisation only). The list is built from sign-ins (table `tenant_people`), so a person appears after their first sign-in.

Assignment safety: when a case is assigned, the server looks the assignee up in this list and uses the management chain from the identity provider (`reports_to` claim). The browser can no longer supply it, so a conflict of interest cannot be hidden by a crafted request. Parties who are known people get their chain from the same list.
