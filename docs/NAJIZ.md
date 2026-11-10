# Najiz integration

Status: **built and tested against a simulator; not connected to the real Najiz.** The real wire format (endpoints, field names, court and claim codes) is only visible to registered Najiz Developers Portal accounts, so it is isolated in one file (`src/najiz/contract.ts`) that is deliberately empty. Everything around it is built and tested.

## How a filing works

1. Counsel gets the matter to **Pre-action** with a forum, a `filing` document and (labour) the amicable-settlement record. These are exactly the prerequisites of the existing "File with the forum" step; Najiz submission cannot bypass them.
2. A **different general counsel** records an approval. The approval counts only if it was recorded after the filing/exhibits were last changed and after the previous attempt: one approval = one version, one attempt.
3. Counsel presses *File through Najiz*. The platform builds the packet from an **allowlist** (title, forum, claim value, claimant, opposing party, documents of type `filing` and `exhibit`), commits a `najiz_filing_pending` artifact, and only then calls Najiz.
4. The outcome is recorded as an artifact: `najiz_filing_result` (with Najiz reference), `najiz_filing_rejected` (definitive; correct and resubmit), `najiz_filing_not_sent` (provably not processed; safe to retry), or `najiz_filing_unconfirmed`.
5. **Unconfirmed** (timeout, dropped connection, 5xx after sending) is never retried automatically: a lawsuit filed twice cannot be undone. Submission is blocked until a general counsel reconciles (`filed` + Najiz reference, or `not_filed`) after checking in Najiz.
6. *Update from Najiz* imports hearings, notices and judgments as artifacts (`hearing_record`, `judgment`, `najiz_notice`, `najiz_status`) with their documents, idempotently. **It never moves the case**: counsel performs the transition under the normal guards. The court case number is filled only if empty.

Routes: `GET /cases/:id/najiz`, `POST …/najiz/submit`, `POST …/najiz/sync`, `POST …/najiz/reconcile`. Legal matters only; counsel role required; same tenant/privilege walls as the case.

## Configuration

`NAJIZ_MODE=off` (default) | `simulated` (dev/QA only; the server refuses it, and every route ignores it, when `NODE_ENV=production`) | `live` with `NAJIZ_TENANTS` JSON per client: base/token URLs (https only), `allowedHosts`, names of the environment variables holding the Consumer Key and Secret (secrets never in the JSON), and the claimant's identifier. The gateway never follows redirects, refuses other hosts, and never logs secrets.

## Onboarding checklist (per client organisation: blocks go-live)

1. Client registers on the Najiz Developers Portal (Nafath sign-in; unified national number; review ≈ 72 working hours).
2. **Data-sharing agreement with the Ministry of Justice** signed by the client.
3. Create the application; link it to each service needed (courts; enforcement later) and wait for approval.
4. Receive Consumer Key/Secret; confirm the test environment and its host. Store them in the client's secret store; fill `NAJIZ_TENANTS`.
5. Read the courts services' Swagger. Implement `NajizContract` in `src/najiz/contract.ts`: request mapping, response parsing, status mapping, error classification, idempotency header if supported. Confirm the **OAuth grant** in `http.ts → token()` (assumed client-credentials with Basic auth).
6. Decide with counsel: party identifier fields (national ID/iqama/CR), forum → court/claim-type codes, document rules (formats, size, signing), whether Najiz pushes events (today: pull on demand; a scheduled sync needs the job queue).
7. Run the QA plan section I against the Najiz test environment, then a supervised first real filing.

## Not done / open

- Wire mapping (above). Nothing in `contract.ts` is guessed.
- Scheduled sync (needs job queue); enforcement-request submission; appeal filings.
- Per-tenant secret rotation procedure; Najiz-side signing/e-stamp requirements, if any.
- Postgres behaviour of the concurrency guard (`FOR UPDATE` on the case row) is not exercised in this build environment; the in-memory repo serialises equivalently.
