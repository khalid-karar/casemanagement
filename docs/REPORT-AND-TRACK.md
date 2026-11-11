# Report & Track: design record

**What it is.** A reporter with no account scans a QR code or opens a link, writes a report, and receives a reference code. With that code they can come back to read replies and add information, without ever identifying themselves. Staff see the report in an inbox, talk to the reporter through the same thread, and either turn the report into a case or close it with a reason.

**Why a report is not a case.** A case has departments, walls, clearances and a workflow. A report from a stranger has none of that until a person decides what it is. Keeping reports in their own store means the anonymous routes can reach reports and channels and nothing else, by construction (`src/api/public-reports.ts` is handed only a narrow store).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Who may read and triage reports? | `ethics_officer` only (not tenant admin, not department heads) | The smallest audience that can do the job. The same role already may see sealed reporter identities. |
| How does the reporter come back? | 120-bit reference code, shown once, only its SHA-256 stored | Nothing to steal that identifies a person; the code cannot be recovered, which the page says plainly. |
| How is the tenant found without sign-in? | A 22-character token in the channel URL (QR). Row-level security lets an unauthenticated request read exactly the one channel row it names | A request with no tenant can do one thing only. |
| What is stored about the reporter? | Category, language, text, timestamps. No address, user agent, cookie, or any id | Anonymity is a property of what is not collected. |
| Abuse controls | Body and length caps; per-source limit on a salted daily-rotating hash held in memory; per-channel circuit breaker; gateway WAF | No proof-of-work: it taxes honest reporters on old phones. Accepted risk: a flood can close a channel for an hour. |
| Integrity | Each report's history is a hash chain (the same one cases use) holding digests of every message; the database forbids rewriting it; message text is encrypted at rest and bound to its report and message number | Tampering, deletion or swapping of messages is detectable, and staff views fail closed if verification fails. |
| What does the reporter learn? | "Received", "accepted" or "closed", and the thread. Never a name, case number, or reason for closing | The reporter cannot learn who handled it or where it went. |
| What happens to a dismissed report that gets a reply? | It reopens | A second look is cheap; the thread cap bounds abuse. |

## Known limits
See `docs/handoff/KNOWN-GAPS.md`, section L.
