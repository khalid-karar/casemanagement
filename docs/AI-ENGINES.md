# AI engines and client consent

Two engines, chosen **per client**. The model is configuration, not code.

| Engine | When used | Config |
|--------|-----------|--------|
| **Sovereign** (our own model on our own GPU) | Default whenever configured; the only option for a client that has not signed | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_ALLOWED_HOSTS`, `LLM_API_KEY` |
| **In-Kingdom cloud API** (Azure / Google / other) | Only for a client whose authorised admin signed the consent, and only while it is valid | `INKINGDOM_LLM_BASE_URL`, `_NAME`, `_REGION`, `_MODEL`, `_ALLOWED_HOSTS`, `_API_KEY`, `_AUTH_HEADER` |

Leave `LLM_BASE_URL` unset until a client needs own-model-only; the sovereign engine is then ready to switch on with no code change.

## Rules enforced in code (and tested)
- **Fail-closed.** No valid consent means the external provider is never called. If no own model exists either, AI is off (HTTP 503), never silently routed outside.
- **Consent is invalidated** by withdrawal, by a new consent wording version, or by a change of provider or region. The client must sign again.
- **Signer proof.** Only a user with role `tenant_admin` of that client can sign. The request must carry the hash of the exact bilingual text shown, their name and title, and an explicit acknowledgement. All of it is stored.
- **Never sent to the external provider:** privileged legal matters, sealed reporter identities (even for users allowed to see them), and anything the asking user cannot access. Personal fields (names etc.) are masked unless the client opted in at signing.
- **Audit.** Consent changes and every AI call are in an append-only log per client (who, when, engine, provider, model; **no prompt or answer content**). Clients see it at `GET /ai/log`.
- **Transparency.** Every answer shows which engine produced it.
- **Platform tenant** (public national law only) may use either engine without consent; it never holds client data.

## Before going live
- Counsel must finalise the consent wording (`src/ai/consent.ts` is a DRAFT). Bump `CONSENT_VERSION` after any change.
- Get the provider's written confirmation: processing region, that the chosen model runs there, zero retention including abuse-monitoring logs, no training on submitted data.
- Test Arabic quality of the chosen model on real case tasks and law questions.
