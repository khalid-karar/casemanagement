# AI model decision

**Default: Qwen3.8-27B** (Apache 2.0, dense 27B fits one GPU, 262K context, strong multilingual incl. Arabic).
Served by vLLM/SGLang inside the Kingdom (e.g. SCCC by stc); the code talks to any OpenAI-compatible endpoint, so the model is configuration.

**Unverified:** the Hugging Face model card was unreachable from the build environment, so the exact repo id, licence text and Arabic quality come from secondary sources. Confirm before procurement.

**A/B candidates:** Falcon-H1 Arabic 34B, Jais 2, ALLaM (only a 7B is reportedly open). Run `pnpm eval:ai` (Arabic case tasks) on each and pick on results, not leaderboards.

**Guardrails (model-independent):** permission-filtered retrieval before the prompt, excerpts treated as untrusted, citations validated against permitted chunks, output is DRAFT only, AI can never transition a case, in-Kingdom host allowlist (PDPL Art. 29).
