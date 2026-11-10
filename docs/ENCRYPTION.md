# Encryption at rest

## What is encrypted
AES-256-GCM, in the application, before data reaches Postgres:

| Data | Encrypted |
|---|---|
| Case fields marked PERSONAL or SEALED | yes |
| Party identities (`personId`) | yes |
| Artifact payloads (findings, notes, filing contents) | yes |
| Corrective-action descriptions | yes |
| Stored case documents (bytes) | yes |
| NORMAL fields (title, dates, enums), state, department, ids | no, needed for filtering, sorting, search |
| Audit log | holds no sensitive values: PERSONAL/SEALED changes are recorded as hashes |

Each value is bound to where it lives (tenant, case, field/artifact/document). Copying ciphertext to another case, field or tenant makes it fail to decrypt. Any decryption failure returns a 500 and shows nothing: there is no partial or fallback output.

## Keys
- **Master key(s)**: held outside the database. `DATA_MASTER_KEYS` (JSON `{"k1":"<base64 32 bytes>"}`) or `DATA_MASTER_KEYS_FILE`; `DATA_MASTER_KEY_ID` selects the one used for new wraps.
- **Data key per tenant**, versioned, stored wrapped in `tenant_keys` (row-level security; append-only for the app role). Created on first use, race-safe.
- A database copy or backup alone reveals nothing without the master key. **Back the master key up separately from the database; losing it means losing the data.**
- Production refuses to start without a master key unless `ALLOW_PLAINTEXT_STORAGE=true`.
- Adding a cloud key vault later means implementing the same wrap/unwrap on `MasterKeys`; nothing else changes.

## Operations (`pnpm crypto ...`, needs `DATABASE_ADMIN_URL`, a role that can see all tenants)
- `gen-master <id>`: new master key entry.
- `status`: which master key wraps which tenant key; cases still without encrypted content.
- `rewrap`: after adding a new master key and setting `DATA_MASTER_KEY_ID`, re-wrap all tenant keys. Retire the old master only after this has run and no backup that needs it remains.
- `rotate-dek [tenant]`: new data-key version; new writes use it, old data stays readable.
- `reencrypt`: encrypt plaintext cases written before encryption was on, and move cases to the newest data key. Documents are append-only and stay under their original key version.

## Switching it on for existing data
Set the keys, restart, run `pnpm crypto reencrypt`. Existing plaintext keeps working in the meantime and is encrypted whenever a case is saved.
